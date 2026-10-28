/*
 * SessionRaiAssistant.hpp
 *
 * Copyright (C) 2026 by Posit Software, PBC
 *
 * Unless you have received this program directly from Posit Software pursuant
 * to the terms of a commercial license agreement with Posit Software, then
 * this program is licensed to you under the terms of version 3 of the
 * GNU Affero General Public License. This program is distributed WITHOUT
 * ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
 * AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
 *
 */

#ifndef RSTUDIO_SESSION_MODULES_RAI_ASSISTANT_HPP
#define RSTUDIO_SESSION_MODULES_RAI_ASSISTANT_HPP

#include <cstdint>
#include <string>
#include <vector>

namespace rstudio {
namespace core {
class Error;
class FilePath;
namespace http {
class Request;
class Response;
} // namespace http
namespace json {
class Value;
} // namespace json
} // namespace core
} // namespace rstudio

namespace rstudio {
namespace session {
namespace modules {
namespace rai_assistant {

core::Error initialize();

// Loopback URL the client loads for a given bridge port. Pure/testable:
// no process or network state.
std::string formatBridgeUrl(int port);

// Existing fixed-log diagnostic reader; at most maxBytes retained from one EOF.
std::string readFileTail(const core::FilePath& path, std::size_t maxBytes);

// Digest the exact settings bytes captured or committed by the native owner.
// Pure: no second file read can change the revision paired with that snapshot.
core::Error raiSettingsRevision(const std::string& bytes, std::string* revision);

// Serialize/parse the persisted per-window bridge state file
// ("<port>\n<pid>"). Pure/testable. parse tolerates a legacy port-only file
// (pid reported as -1) and rejects non-numeric content. The port lets a fresh
// rsession reconnect to a bridge that survived "Restart R"; the pid lets a
// hard reset SIGKILL it (the bridge ignores SIGTERM). The first line stays a
// bare integer so the desktop launcher's port-only reader keeps working.
std::string formatBridgeStateFile(int port, long pid);
bool parseBridgeStateFile(const std::string& contents, int* pPort, long* pPid);

// rai_get_bridge_url status for a bridge whose spawn-or-reconnect (start)
// succeeded or failed and which is or is not yet reachable on its port. A
// best-effort workspace refresh failure is deliberately NOT an input here: it
// must never downgrade a reachable bridge to an error, which is exactly the
// v0.1.15 startup regression. Returns "not_found" | "starting" | "ready".
std::string raiBridgeUrlStatus(bool startFailed, bool reachable);

// The single-Console-run exclusion contract. At most one approved run may be in
// flight, so the native input/output correlation is unambiguous.
//
// The slot is claimed by bridge proposal id (reserve) BEFORE the R broker is
// asked to gate and register the run, because evaluating R can process events and drain
// another /run off the same listener queue -- checking "idle" and then acting on
// it would not be atomic. arm() then attaches the registered run to the slot the
// caller already holds, and returns false if it no longer holds one.
//
// raiInFlightRunForDigest reports the run only for the same proposal and exact
// source/max_lines binding. A mismatch exposes no run id; Reserved reports busy.
// R independently retains its approval/digest checks. It matches only
// while the run is in flight -- once the slot is free an identical proposal is a deliberate re-run
// and must get its own approval and run id, never a stale result.
//
// These drive process-global state; reset between uses.
bool raiReserveConsoleCapture(const std::string& digest);
bool raiArmConsoleCapture(const std::string& runId, const std::string& code,
                          const std::string& codeHash = std::string(), int maxLines = 200);
bool raiInFlightRunForDigest(const std::string& digest, const std::string& code,
                             int maxLines, std::string* pRunId,
                             bool* pPayloadMismatch);
// Feed one Console-input event into the armed capture. Multiline source may
// arrive whole, cumulatively, or one physical line at a time; returns true only
// when the event sequence reconstructs the exact approved source.
bool raiAcceptConsoleInput(const std::string& input);
bool raiIsConsoleCaptureCapturing();
// Test-only output event hook for asserting monitor counters independently of
// the R scheduler. It does not enqueue or evaluate R.
void raiAppendConsoleOutputForTests(bool isError, const std::string& output);
void raiResetCapture();

// Time/input observations alone never authorize force-releasing an occupied
// capture. Native completion/pre-enqueue failure/session teardown own release;
// bounded monitor waiting is separate. Existing pure policy decision.
bool raiShouldExpireCapture(bool reservedOrArmed,
                            bool sawInputSinceArm,
                            int elapsedSecs);

// Pure classifier behind /viewer. Derives bounded active/kind/transport
// metadata from the internal viewer URL and HTML-widget flag without ever
// exposing the URL itself -- the URL is consumed here only to decide these
// three bounded values, never serialized. Testable directly.
void raiClassifyViewerState(const std::string& viewerUrl,
                            bool isHTMLWidget,
                            bool* pActive,
                            std::string* pKind,
                            std::string* pTransport);

// Test-only hooks for the /viewer endpoint's method/auth/body gating
// (405/401/400), mirroring the other session-endpoint handlers -- none of
// which are otherwise reachable outside a live rsession. These drive the same
// process-global token state consumed by every /run, /result, /debug, /plot,
// and /viewer request.
void raiSetSessionEndpointTokenForTests(const std::string& token);
core::Error raiHandleViewerStateRequestForTests(const core::http::Request& request,
                                                core::http::Response* pResponse);
// Test-only hook for the read-only `/monitor` capture snapshot endpoint. It
// accepts only one opaque run id and must never enqueue/interrupt R.
core::Error raiHandleConsoleMonitorRequestForTests(const core::http::Request& request,
                                                   core::http::Response* pResponse);
core::Error raiHandleProjectContextRequestForTests(const core::http::Request& request,
                                                   core::http::Response* pResponse);

// Test-only hook for the /file endpoint, mirroring the /project_context and
// /viewer hooks above -- the gtest session has no project open and no real
// filesystem fixture wired into the listener, so a unit test drives the
// handler directly.
core::Error raiHandleReadProjectFileRequestForTests(const core::http::Request& request,
                                                    core::http::Response* pResponse);

// Test-only hook for the /edit endpoint, mirroring the /file hook above --
// covers method/token/field-shape gating (405/401/400) without requiring a
// real open document.
core::Error raiHandleDocumentEditRequestForTests(const core::http::Request& request,
                                                 core::http::Response* pResponse);

// Wire-boundary validator for read_project_file's path argument: non-empty,
// project-relative, no absolute or ".." component, no NUL byte. Pure/testable
// independent of any live project or filesystem state.
bool raiIsValidProjectRelativePathArgument(const std::string& path);

// True only when contents decode entirely as UTF-8 with no embedded NUL.
// Pure/testable.
bool raiIsBoundedUtf8Text(const std::string& contents);

// Strict decimal byte offset used to page read_project_file responses. The
// caller-provided offset must be non-negative, canonical decimal, and fit the
// native size type; malformed/overflowing values are rejected before disk I/O.
bool raiParseProjectFileOffsetField(const std::string& value, std::size_t* pOffset);

// One entry in the /project_context manifest. path is ALWAYS relative to the
// session root the walk was given and uses '/' separators; there is no field
// for an absolute path, a parent directory, or file contents.
struct RaiProjectFileEntry
{
   std::string path;
   std::string kind;
   std::uintmax_t sizeBytes;
};

// Bounded label for a manifest entry, derived from the file extension alone:
// "r_script" | "r_markdown" | "project" | "data" | "other". Pure/testable.
std::string raiProjectFileKind(const std::string& filename);

// The /project_context manifest walk. get_project_context accepts no path
// argument, so root is only ever the session's own project directory or its
// current working directory -- never anything a caller supplied. The walk is
// deliberately narrow: at most maxFiles entries, at most maxDepth path
// components below root, regular files only, hidden entries skipped, symlinks
// never followed (so it cannot be led outside root), and results in
// deterministic depth-first lexicographic order. *pTruncated reports whether
// the cap dropped entries, so a partial manifest is never read as complete.
void raiCollectProjectFiles(const core::FilePath& root,
                            std::size_t maxFiles,
                            int maxDepth,
                            std::vector<RaiProjectFileEntry>* pFiles,
                            bool* pTruncated);

// Working directory expressed relative to root ("." when they are the same).
// Returns an empty string when the working directory is not within root: this
// endpoint reports "no relative form" rather than leaking an absolute path or
// a ".." escape. Pure/testable.
std::string raiRelativeWorkingDirectory(const core::FilePath& root,
                                        const core::FilePath& workingDir);

// Bounds for the optional get_plot_image history index. raiParsePlotIndexField
// is the wire boundary (a plain decimal ordinal, nothing else, before the
// graphics display is touched); raiIsValidPlotIndex is the live-session
// boundary against the current plot count. Both pure/testable.
bool raiParsePlotIndexField(const std::string& value, int* pIndex);
bool raiIsValidPlotIndex(int index, int plotCount);

// Strict syntactic boundary for the read-only /debug and /result endpoints.
// Excludes expressions, paths, and arbitrary lookup keys before R is entered.
bool raiIsValidRunId(const std::string& runId);

// Strict bare-identifier boundary for optional /debug object summaries. This
// excludes expressions, member/index syntax, namespaces, paths, whitespace,
// and backticks before the request can enter R.
bool raiIsValidObjectName(const std::string& objectName);

// Strict enum-style boundary for get_environment_summary's optional
// summary_mode field: exactly "full" (the existing shape) or "nrow" (bounded
// row/class-only metadata, never a column enumeration). Any other value --
// including case variants or anything with trailing content -- is rejected
// before the request can enter R, exactly like raiIsValidObjectName above.
bool raiIsValidSummaryMode(const std::string& summaryMode);

// Converts one UTF-8 editor line to the UTF-16 code-unit column convention
// used by the GWT/Ace source editor. Invalid input is counted byte-by-byte so
// native range generation stays bounded and never walks past the input.
int raiUtf8ToUtf16CodeUnitCount(const std::string& utf8);

// Bounded, pure snapshot of a document buffer's structure: total line count
// (a '\n'-separated entry count that never drops a trailing blank line the
// way R's strsplit() would), blank-line count, and literal "```" occurrence
// count. chunkParseCount is deliberately NOT populated by the pure function
// below -- counting parseable R fenced chunks requires the R parser, so only
// the anonymous-namespace caller with a live R interpreter fills it in.
struct RaiBufferAudit
{
   int totalLines = 0;
   int blankLines = 0;
   int fenceCount = 0;
   int chunkParseCount = 0;
};

// Pure/testable. Populates every RaiBufferAudit field except chunkParseCount
// (left at 0).
RaiBufferAudit raiAuditBufferStructure(const std::string& text);

// Pure/testable. True only when the buffer-wide change between before/after
// is exactly what swapping expected for replacement predicts: the delta in
// totalLines equals the delta in newline counts between replacement and
// expected, and the delta in fenceCount equals the delta in their literal
// "```" occurrence counts. These are the only two RaiBufferAudit fields a
// substring replace can predict unconditionally, independent of where the
// match falls in the document -- blankLines and chunkParseCount can depend
// on text outside the replaced span, so they are reported but never used to
// fail this check.
bool raiBufferChangeIsExpected(const RaiBufferAudit& before,
                               const RaiBufferAudit& after,
                               const std::string& expected,
                               const std::string& replacement);

// Outcome of anchoring one proposed edit against the document text it will
// be applied to.
enum class RaiAnchorValidation
{
   kOk,
   kNotUnique,
   kContextMismatch
};

// Pure/testable. expected must occur exactly once in documentText, or this
// returns kNotUnique. A non-empty contextBefore/contextAfter must then
// exactly and immediately precede/follow that one occurrence, or this
// returns kContextMismatch; an empty context string means "not supplied" and
// skips that side's check -- callers that require context (e.g. a .Rmd edit)
// enforce that upstream of this function. On kOk, *pMatchStart is the byte
// offset of the match.
RaiAnchorValidation raiValidateAnchoredEdit(const std::string& documentText,
                                            const std::string& expected,
                                            const std::string& contextBefore,
                                            const std::string& contextAfter,
                                            std::size_t* pMatchStart);

// Pure/testable. In-place normalizes any field in `fields` that is present in
// *pValue (an already-built JSON object) and holds a 1-element JSON array
// back to that element's bare scalar; recurses one level into any field that
// is itself a JSON object (e.g. a nested {file, seq} trace-link record). No
// effect on fields absent from the object, fields whose array has size != 1,
// or fields not named in `fields` at all -- other array-valued fields (e.g.
// a "capabilities" list) are never touched unless a caller explicitly
// includes that name, which no current call site does.
void raiUnwrapSingleElementArrays(core::json::Value* pValue, const std::vector<std::string>& fields);

// Pure/testable. Only a .Rmd document (kSourceDocumentTypeRMarkdown) requires
// context_before/context_after; every other editable type keeps them
// optional.
bool raiDocumentEditRequiresContext(const std::string& documentType);

// Pure/testable. True for environment/profile/workspace files (.Renviron,
// .Rprofile, .RData, *.rda, .Rhistory, renv.lock, ~/.raistudio/...), which the
// Assistant never edits directly regardless of the automation setting.
// Read purpose permits ordinary environment files but still protects internal
// .raistudio auth/state. Callers must keep all other path/text/session checks.
bool raiIsEnvironmentFilePath(const std::string& path, bool forRead = false);

enum class RaiWriteClass { kCode, kDeniedData, kDeniedEnv, kUnknown };
RaiWriteClass raiClassifyWritePath(const std::string& path);

struct RaiResetProcessIdentity
{
   RaiResetProcessIdentity() : pid(-1), alive(false), portReachable(false) {}

   long pid;
   bool alive;
   bool portReachable;
   std::string executablePath;
   std::string workingDirectory;
   std::string startMarker;
   std::vector<std::string> arguments;
};


// Pure/testable hard-reset authorization boundary. A PID is returned only
// when current-session tracking, persisted state/port context, and observed
// process identity all describe the exact bridge this session spawned.
// Otherwise returns -1; reset still discards state and starts fresh.
long raiVerifiedResetKillTarget(long trackedPid,
                                int trackedPort,
                                long stateFilePid,
                                int stateFilePort,
                                const std::string& expectedExecutablePath,
                                const std::string& expectedBridgeDirectory,
                                const std::string& expectedStartMarker,
                                const RaiResetProcessIdentity& observed);

enum class RaiResetTerminationPolicy
{
   None,
   PosixSigkill,
   WindowsTerminateProcess
};

// Pure/testable platform termination policy applied only to the PID returned
// by raiVerifiedResetKillTarget(). Unverified PIDs select no process control.
RaiResetTerminationPolicy raiResetTerminationPolicy(long verifiedPid,
                                                     bool isWindows);

} // namespace rai_assistant
} // namespace modules
} // namespace session
} // namespace rstudio

#endif /* RSTUDIO_SESSION_MODULES_RAI_ASSISTANT_HPP */
