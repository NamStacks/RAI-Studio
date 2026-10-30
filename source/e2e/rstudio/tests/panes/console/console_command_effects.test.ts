import { test, expect } from '@fixtures/rstudio.fixture';
import { ConsolePaneActions } from '@actions/console_pane.actions';

test.describe('Console command effects', () => {
  let consoleActions: ConsolePaneActions;

  test.beforeAll(async ({ rstudioPage: page }) => {
    consoleActions = new ConsolePaneActions(page);
  });

  test.beforeEach(async () => {
    await consoleActions.clearConsole();
  });

  test("packageVersion('base') auto-prints the version", async () => {
    await consoleActions.executeInConsole("packageVersion('base')");
    await expect(consoleActions.consolePane.consoleOutput).toContainText('[1]');
  });

  test('help.start() loads the R help index into the Help pane', async ({ rstudioPage: page }) => {
    await consoleActions.executeInConsole('help.start()');
    const helpFrame = page.frameLocator('#rstudio_help_frame');
    await expect(helpFrame.locator('body')).toContainText('Statistical Data Analysis', {
      timeout: 30000,
    });
  });

  test('help(package = "base") loads package help into the Help pane', async ({ rstudioPage: page }) => {
    await consoleActions.executeInConsole("help(package = 'base')");
    const helpFrame = page.frameLocator('#rstudio_help_frame');
    await expect(helpFrame.locator('body')).toContainText('The R Base Package', {
      timeout: 15000,
    });
  });

  test('plot(x, y) renders a plot in the Plots pane', async ({ rstudioPage: page }) => {
    await consoleActions.executeInConsole('x <- 1');
    await consoleActions.executeInConsole('y <- 1');
    await consoleActions.executeInConsole('plot(x, y)');
    await expect(page.locator('#rstudio_plot_image_frame')).toBeVisible({ timeout: 15000 });
  });

  test('rstudioDiagnosticsReport() writes a diagnostics report', async () => {
    await consoleActions.executeInConsole('rstudioDiagnosticsReport()');
    await expect(consoleActions.consolePane.consoleOutput).toContainText(
      'Diagnostics report written',
      { timeout: 90000 },
    );
  });

  test('install.packages() reports not-available for a non-existent package', async () => {
    await consoleActions.executeInConsole(
      "install.packages('fake_package', repos = 'https://cran.r-project.org')",
    );
    await expect(consoleActions.consolePane.consoleOutput).toContainText(
      "‘fake_package’ is not available",
      { timeout: 45000 },
    );
  });

  test('install.packages() installs a real CRAN package that library() can load', async () => {
    // Never uninstall an existing system/user package. This independent library
    // lives in the disposable test rsession's tempdir and proves fresh install.
    await consoleActions.executeInConsole(
      "rai_pkg_lib <- file.path(tempdir(), 'rai-fresh-praise'); dir.create(rai_pkg_lib, recursive = TRUE)",
    );
    await consoleActions.executeInConsole(
      "install.packages('praise', lib = rai_pkg_lib, repos = 'https://cloud.r-project.org')",
      { timeout: 120000 },
    );
    await consoleActions.executeInConsole(
      "stopifnot(file.exists(file.path(rai_pkg_lib, 'praise', 'DESCRIPTION'))); " +
      "library('praise', lib.loc = rai_pkg_lib); " +
      "cat('RAI_FRESH_PRAISE_LOADED:', normalizePath(find.package('praise', lib.loc = rai_pkg_lib)), '\\n')",
    );
    await expect(consoleActions.consolePane.consoleOutput).toContainText('RAI_FRESH_PRAISE_LOADED:');
    await expect(consoleActions.consolePane.consoleOutput).not.toContainText('Error in library');
  });
});
