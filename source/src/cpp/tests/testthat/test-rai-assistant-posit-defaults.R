#
# test-rai-assistant-posit-defaults.R
#
# Copyright (C) 2026 by Posit Software, PBC
#
# Unless you have received this program directly from Posit Software pursuant
# to the terms of a commercial license agreement with Posit Software, then
# this program is licensed to you under the terms of version 3 of the
# GNU Affero General Public License. This program is distributed WITHOUT
# ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
# MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
# AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
#

context("RAI Assistant Posit defaults")

posit_schema_path <- function()
   normalizePath(file.path(getwd(), "..", "..", "session", "resources", "schema", "user-prefs-schema.json"),
                 winslash = "/", mustWork = FALSE)

test_that("the Posit Assistant prefs default to none so nothing contacts Posit unless the user opts in", {
   path <- posit_schema_path()
   expect_true(file.exists(path), info = path)
   if (file.exists(path))
   {
      schema <- jsonlite::fromJSON(path, simplifyVector = FALSE)
      for (name in c("assistant", "chat_provider"))
      {
         expect_identical(schema$properties[[name]]$default, "none", info = name)
         expect_true("posit" %in% unlist(schema$properties[[name]]$enum), info = name)
      }
   }
})

test_that("the effective prefs in this session are none when no layer sets them", {
   skip_if_not(exists(".rs.readUiPref"), ".rs.readUiPref is not available")
   for (name in c("assistant", "chat_provider"))
      expect_identical(.rs.readUiPref(name), "none", info = name)
})
