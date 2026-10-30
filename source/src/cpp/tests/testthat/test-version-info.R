context("Native RStudio version metadata")

test_that("native numeric version agrees with long version without an empty suffix component", {
   info <- RStudio.Version()
   base <- sub("^([0-9]+\\.[0-9]+\\.[0-9]+).*$", "\\1", info$long_version)
   suffix <- sub("^[0-9]+\\.[0-9]+\\.[0-9]+", "", info$long_version)
   numericSuffix <- gsub("[a-zA-Z+-]", "", suffix)
   expected <- if (nzchar(numericSuffix)) paste(base, numericSuffix, sep = ".") else base
   expect_identical(as.character(info$version), expected)
   expect_identical(as.character(.rs.api.getVersion()), expected)
   expect_false(grepl("\\.$", as.character(info$version)))
})
