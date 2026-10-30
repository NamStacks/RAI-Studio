import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FullConfig } from '@playwright/test';
import { prepareRLibs } from './r-libs-setup';
import { launchRStudio, shutdownRStudio } from './desktop.fixture';
import { hostClaudeSessionRequested, setupHostClaudeSession } from './host-claude-session';

/**
 * Real provider credentials are never copied by default. A deliberately
 * interactive live-provider run may opt in with PW_SEED_AI_CREDENTIALS=1.
 */
export function shouldSeedAiCredentials(value: string | undefined): boolean {
  return ['1', 'true'].includes((value ?? '').toLowerCase());
}

/**
 * Copy one explicitly-authorized test provider credential into the sandbox
 * user-home and set `envVar=1` so the matching @ai tests can run.
 */
function seedAiCredential(opts: {
  label: string;
  src: string;
  dest: string;
  destDisplay: string;
  envVar: string;
  isFile?: boolean;
  fileMode?: number;
}): void {
  const { label, src, dest, destDisplay, envVar, isFile, fileMode } = opts;
  if (!fs.existsSync(src)) {
    console.log(`[sandbox] no ${src} on host; @ai ${label} tests will skip`);
    return;
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (isFile) {
      fs.copyFileSync(src, dest);
      if (fileMode !== undefined)
        fs.chmodSync(dest, fileMode);
    } else {
      fs.cpSync(src, dest, { recursive: true });
    }
    process.env[envVar] = '1';
    console.log(`[sandbox] seeded ${destDisplay} from ${src}`);
    console.warn(
      `[sandbox] WARNING: Real ${label} credentials were copied into the sandbox from ${src}. Tokens persist if the run is preserved or teardown fails. Set PW_SANDBOX_NO_SEED_CREDENTIALS=1 to opt out.`,
    );
  } catch (err) {
    throw new Error(`Failed copying ${src} into sandbox: ${(err as Error).message}`);
  }
}

/**
 * Create a per-invocation sandbox directory and export its path as PW_SANDBOX.
 *
 * The sandbox is the single rooted tree under which every test-side artifact
 * lives: per-spec config trees (each carrying its own RSTUDIO_DATA_HOME --
 * see desktop.fixture's createTempConfig), R workdirs, the sandbox-level
 * data-home (the seeded-pai source; Desktop sessions do not use it as their
 * data home), and the shared user home (HOME/USERPROFILE). The companion
 * sandbox-teardown removes the subtree once the run finishes (unless
 * preserved by the rules in that file).
 *
 * Env vars (all optional):
 *   PW_SANDBOX_ROOT                Parent dir for the sandbox subtree. Defaults
 *                                  to os.tmpdir().
 *   PW_SANDBOX_ROOT_CREATE         "1"/"true" to mkdir PW_SANDBOX_ROOT if
 *                                  missing. Default is to fail loudly on a
 *                                  missing parent so typos surface immediately.
 *   PW_SEED_PAI                    Path to a Posit Assistant install directory
 *                                  (e.g. ~/.local/share/rstudio/pai, as
 *                                  produced by the assistant repo's
 *                                  `npm run deploy:rstudio`). Copied into the
 *                                  sandbox data-home, from where each per-spec
 *                                  data home links it, so tests run against
 *                                  that local build instead of downloading
 *                                  the official package. Only the install
 *                                  shape (bin/package.json present) is
 *                                  validated here; version/protocol
 *                                  compatibility is enforced by the IDE at
 *                                  runtime, which treats an incompatible
 *                                  seeded build as needing an update.
 *   PW_SEED_AI_CREDENTIALS          "1"/"true" to explicitly authorize copying
 *                                  real AI credentials into the sandbox for a
 *                                  live-provider test run. Default false.
 *   PW_SANDBOX_NO_SEED_CREDENTIALS "1"/"true" is a legacy defense-in-depth
 *                                  opt-out and always wins over the opt-in.
 *                                  Unseeded @ai tests are skipped.
 *                                  Privacy note: even explicit live runs copy
 *                                  real OAuth/API tokens; preserved sandboxes
 *                                  retain those tokens until removed.
 *
 * Sets PW_SANDBOX (internal) to the absolute path of the auto-created
 * subtree, and PW_AI_SEEDED_POSITAI / PW_AI_SEEDED_COPILOT to "1" for each
 * provider whose credentials were successfully copied (consumed by
 * requireAiCredentials in @ai test files). Workers inherit them via the
 * normal child-process env; globalTeardown reads PW_SANDBOX directly from
 * process.env.
 */
export default async function globalSetup(config: FullConfig) {
  // Export the resolved worker count so the Desktop fixture and r-libs helpers
  // can decide whether to partition HOME / R_LIBS_USER per worker. The default
  // (1 worker) keeps the historical shared-state behavior; >1 activates the
  // per-worker subtrees. Honor an explicit override if already set.
  if (!process.env.PW_TOTAL_WORKERS)
    process.env.PW_TOTAL_WORKERS = String(config.workers ?? 1);

  const parent = process.env.PW_SANDBOX_ROOT ?? os.tmpdir();
  const shouldCreate = ['1', 'true'].includes(
    (process.env.PW_SANDBOX_ROOT_CREATE ?? '').toLowerCase(),
  );
  if (!fs.existsSync(parent)) {
    if (!shouldCreate) {
      throw new Error(
        `PW_SANDBOX_ROOT="${parent}" does not exist; set PW_SANDBOX_ROOT_CREATE=1 to auto-create`,
      );
    }
    try {
      fs.mkdirSync(parent, { recursive: true });
    } catch (err) {
      throw new Error(
        `Failed to create PW_SANDBOX_ROOT="${parent}": ${(err as Error).message}`,
      );
    }
  }

  // Resolve symlinks in the sandbox path so every downstream consumer sees the
  // same canonical form. On macOS, os.tmpdir() returns the non-canonical
  // /var/folders/... prefix while /var is a symlink to /private/var; rstudioapi
  // and R-side tempdir() normalize to /private/var/..., so paths the test
  // computes JS-side and paths reported by RStudio would differ otherwise.
  // TextEditingTarget's project-prefix check on save (#16721 / styler reformat
  // on save) is one place that breaks under a path-form mismatch.
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'pw_sandbox_')));
  fs.mkdirSync(path.join(sandbox, 'data-home'), { recursive: true });

  // Seed a locally built Posit Assistant into the sandbox data-home so tests
  // exercise it instead of downloading the official package. Desktop launches
  // use per-spec data homes; each links data-home/pai from here (see
  // desktop.fixture's seedPaiIntoDataHome).
  const seedPai = process.env.PW_SEED_PAI;
  if (seedPai) {
    if (!fs.existsSync(path.join(seedPai, 'bin', 'package.json'))) {
      throw new Error(
        `PW_SEED_PAI="${seedPai}" does not look like a Posit Assistant install (missing bin/package.json)`,
      );
    }
    fs.cpSync(seedPai, path.join(sandbox, 'data-home', 'pai'), { recursive: true });
    console.log(`[sandbox] seeded data-home/pai from ${seedPai}`);
  }

  const userHome = path.join(sandbox, 'user-home');
  fs.mkdirSync(userHome, { recursive: true });

  // Seed an empty `.here` marker in the sandbox home. The home dir has no
  // project markers (.Rproj/.git/renv.lock/...), so any R code that resolves a
  // project root via the `here` / `rprojroot` packages -- e.g. reticulate's
  // pipenv interpreter probe, which calls an unguarded here::here() (see
  // rstudio/reticulate#1909) -- throws "No root directory found" when run from
  // here. That error has surfaced as a spurious modal (e.g. "Error Listing
  // Packages" on session resume) whose glass overlay then wedges unrelated
  // tests. `.here` is the marker `here` looks for first, so it makes here()
  // resolve to the home dir instead of erroring. It only affects code that
  // actually calls here()/rprojroot; RStudio's own project detection ignores it.
  fs.writeFileSync(path.join(userHome, '.here'), '');

  // On Windows, redirecting USERPROFILE to a directory that doesn't contain
  // an AppData/Roaming subdirectory makes Electron's app.getPath('appData')
  // fail at startup ("Failed to get 'appData' path" popup), which blocks
  // RStudio from launching at all. Pre-create the standard AppData scaffolding
  // inside the sandboxed user-home so Electron's resolution succeeds.
  // TODO: add macOS (~/Library/Application Support) and Linux Desktop
  // (~/.config) equivalents when those platforms are tested against the
  // HOME/USERPROFILE redirect.
  if (process.platform === 'win32') {
    fs.mkdirSync(path.join(userHome, 'AppData', 'Roaming'), { recursive: true });
    fs.mkdirSync(path.join(userHome, 'AppData', 'Local'), { recursive: true });
  }

  // Seed AI credentials by default when the host has them. The matching @ai
  // tests run requireAiCredentials() which gates each describe on the
  // corresponding PW_AI_SEEDED_* flag set below; unseeded providers surface
  // as a clean skip-with-reason rather than a 5-minute mystery failure
  // waiting for a completion that will never arrive.
  //
  // Clear the flags up front so only values this function sets are honored
  // -- a stray PW_AI_SEEDED_POSITAI=1 inherited from the user's shell or a
  // prior partially-cleaned run could otherwise smuggle past
  // requireAiCredentials() even when no credentials were actually copied.
  delete process.env.PW_AI_SEEDED_POSITAI;
  delete process.env.PW_AI_SEEDED_COPILOT;
  delete process.env.PW_AI_SEEDED_CLAUDE;

  // Credentials are explicitly opt-in. Retain the old no-seed flag as a
  // defense-in-depth override for CI and preserved-sandbox runs.
  const skipSeeding = ['1', 'true'].includes(
    (process.env.PW_SANDBOX_NO_SEED_CREDENTIALS ?? '').toLowerCase(),
  );
  const seedCredentials = !skipSeeding && shouldSeedAiCredentials(
    process.env.PW_SEED_AI_CREDENTIALS,
  );

  if (seedCredentials) {
    // Posit Assistant moved its state directory from ~/.positai to
    // ~/.posit/assistant. Seed whichever the host has, preferring the new
    // location, and mirror it at the same relative path inside the sandbox
    // user-home so the under-test Assistant (which may recognize either)
    // finds it.
    const positaiCandidates = [path.join('.posit', 'assistant'), '.positai'];
    const positaiFound = positaiCandidates
      .map((rel) => ({ rel, abs: path.join(os.homedir(), rel) }))
      .find(({ abs }) => fs.existsSync(abs));
    seedAiCredential({
      label: 'Posit Assistant',
      src: positaiFound?.abs ?? path.join(os.homedir(), '.posit', 'assistant'),
      dest: path.join(userHome, positaiFound?.rel ?? path.join('.posit', 'assistant')),
      destDisplay: `user-home/${positaiFound?.rel ?? path.join('.posit', 'assistant')}`,
      envVar: 'PW_AI_SEEDED_POSITAI',
    });

    const isWindows = process.platform === 'win32';
    seedAiCredential({
      label: 'GitHub Copilot',
      src: isWindows
        ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'github-copilot')
        : path.join(os.homedir(), '.config', 'github-copilot'),
      dest: isWindows
        ? path.join(userHome, 'AppData', 'Local', 'github-copilot')
        : path.join(userHome, '.config', 'github-copilot'),
      destDisplay: 'user-home github-copilot',
      envVar: 'PW_AI_SEEDED_COPILOT',
    });

    // The Claude Code CLI stores its OAuth session in ~/.claude/.credentials.json
    // (a single small file -- not the wider ~/.claude directory, which also
    // holds skills/history/memory unrelated to auth and not needed here). With
    // HOME redirected into the sandbox, the CLI finds no credentials at all
    // and falls into a fresh-login flow whose keychain-save step fails
    // non-interactively (the RAI Assistant bridge spawns it headlessly via
    // node-pty), surfacing as "OAuth error: Failed to save API key to macOS
    // Keychain" inside the embedded terminal instead of a working session.
    seedAiCredential({
      label: 'Claude Code',
      src: path.join(os.homedir(), '.claude', '.credentials.json'),
      dest: path.join(userHome, '.claude', '.credentials.json'),
      destDisplay: 'user-home/.claude/.credentials.json',
      envVar: 'PW_AI_SEEDED_CLAUDE',
      isFile: true,
      fileMode: 0o600,
    });

    // The credentials file alone is not sufficient: the CLI also gates its
    // first-run onboarding wizard (theme picker, trust dialog, etc.) on
    // ~/.claude.json's `hasCompletedOnboarding` flag. A sandbox with no
    // ~/.claude.json at all still has valid OAuth creds but starts a fresh
    // "Let's get started" flow every run instead of dropping straight into
    // a working session -- and depending on exact timing that flow can
    // itself surface as what looks like an OAuth prompt in the embedded
    // terminal, since both share the same startup screen real estate. Seed
    // only the specific onboarding/theme flags needed to skip that wizard,
    // not the whole host ~/.claude.json (which also carries unrelated
    // project history, MCP server config, and usage/growthbook caches that
    // have no business leaking into a hermetic test sandbox).
    try {
      const hostClaudeJsonPath = path.join(os.homedir(), '.claude.json');
      if (fs.existsSync(hostClaudeJsonPath)) {
        const hostClaudeJson = JSON.parse(fs.readFileSync(hostClaudeJsonPath, 'utf8'));
        const onboardingFields = [
          'hasCompletedOnboarding',
          'theme',
          'autoUpdates',
          'installMethod',
          'hasSeenTasksHint',
          'shiftEnterKeyBindingInstalled',
        ];
        const seeded: Record<string, unknown> = {};
        for (const field of onboardingFields) {
          if (field in hostClaudeJson) seeded[field] = hostClaudeJson[field];
        }

        // The CLI also gates a per-directory workspace-trust dialog on
        // projects[<cwd>].hasTrustDialogAccepted -- separate from the
        // global onboarding flags above. The RAI Assistant bridge spawns
        // the CLI with RAI_BRIDGE_CWD, which falls back to os.homedir()
        // (== this sandbox's userHome) when unset; seed a trusted entry
        // for that exact cwd so the dialog doesn't block a headless
        // node-pty session (which cannot answer an interactive prompt).
        // Only the trust/onboarding-suppression flags are copied, never
        // a project's allowedTools/mcpServers/history.
        seeded.projects = {
          [userHome]: {
            allowedTools: [],
            mcpContextUris: [],
            mcpServers: {},
            enabledMcpjsonServers: [],
            disabledMcpjsonServers: [],
            hasTrustDialogAccepted: true,
            projectOnboardingSeenCount: 1,
            hasClaudeMdExternalIncludesApproved: false,
            hasClaudeMdExternalIncludesWarningShown: false,
            hasUnseenTeamArtifacts: false,
          },
        };

        const destClaudeJsonPath = path.join(userHome, '.claude.json');
        fs.mkdirSync(path.dirname(destClaudeJsonPath), { recursive: true });
        fs.writeFileSync(destClaudeJsonPath, JSON.stringify(seeded, null, 2));
        console.log('[sandbox] seeded user-home/.claude.json onboarding flags + pre-trusted sandbox cwd (no real project history)');
      } else {
        console.log(`[sandbox] no ${hostClaudeJsonPath} on host; Claude Code first-run wizard will show in @ai tests`);
      }
    } catch (error) {
      console.log(`[sandbox] failed to seed ~/.claude.json onboarding flags: ${(error as Error).message}`);
    }
  } else if (hostClaudeSessionRequested()) {
    setupHostClaudeSession(userHome);
  } else {
    console.log(
      skipSeeding
        ? '[sandbox] PW_SANDBOX_NO_SEED_CREDENTIALS set; @ai tests will skip'
        : '[sandbox] credential-free by default; set PW_SEED_AI_CREDENTIALS=1 only for an explicit live-provider run',
    );
  }

  process.env.PW_SANDBOX = sandbox;
  // A scratch root can itself live inside an unrelated Git checkout (for
  // example ~/projects). Keep unversioned test projects out of that ancestor's
  // .gitignore while still discovering repositories initialized *inside* the
  // sandbox. RStudio inherits this environment for Find in Files / git grep.
  process.env.GIT_CEILING_DIRECTORIES = sandbox;
  console.log(`[sandbox] root: ${sandbox}`);

  // Stable per-host R library, lives outside PW_SANDBOX so it survives across
  // runs. Without this the redirected HOME (set by Desktop/Server fixtures)
  // points R at an empty default user library, and the first thing rmarkdown
  // does on save is open a "stringr needs updating" dialog that hangs the
  // test. Pre-populating here is idempotent -- a warm cache is a fast
  // installed.packages() check with no install call.
  //
  // The resolved (token-expanded) path is exported so parallel workers can
  // hardlink-clone this prebuilt library into their own hermetic copies
  // (see workerRLibsUser); single-worker runs use it directly.
  const rLibsTemplate = await prepareRLibs();
  if (rLibsTemplate)
    process.env.PW_R_LIBS_TEMPLATE = rLibsTemplate;

  // Warmup launch: workers are recycled between spec files, so each new file
  // pays the cold-launch cost. Booting once here populates dyld/page caches
  // before any worker tries, dropping subsequent launches well under the
  // GWT-ready deadline. Skipped on Server mode (no IDE binary to warm) and
  // when PW_WARMUP_LAUNCH explicitly opts out. Default on under CI only --
  // a developer running locally has warm caches already.
  const mode = (process.env.PW_RSTUDIO_MODE ?? 'desktop').toLowerCase();
  const warmupOverride = process.env.PW_WARMUP_LAUNCH?.toLowerCase();
  const shouldWarmup =
    mode === 'desktop' &&
    (warmupOverride === '1' || warmupOverride === 'true' ||
     (warmupOverride !== '0' && warmupOverride !== 'false' && !!process.env.CI));
  if (shouldWarmup) {
    console.log('[sandbox] warmup launch (populates RStudio launch caches)');
    const t0 = Date.now();
    try {
      const session = await launchRStudio();
      await shutdownRStudio(session);
      console.log(`[sandbox] warmup launch complete in ${Date.now() - t0}ms`);
    } catch (err) {
      // A warmup failure is not fatal -- the first real test will retry the
      // launch via the in-fixture retry. Log it so a persistent failure mode
      // is visible without burning a whole test slot to surface it.
      console.warn(
        `[sandbox] warmup launch failed after ${Date.now() - t0}ms (continuing): ${(err as Error).message}`,
      );
    }
  }
}
