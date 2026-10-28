# Scientific audit checks

Derived from the canonical portable rai-audit skill. Examples use representative objects, not private project data. Apply only to explicitly authorized objects after safe native binding inspection. All R examples are proposals, not automatic execution authority. Findings that imply a scientific choice require user input; do not apply an example fix mechanically. Every result must come from the owning native Console and pass completion and outcome checks.

`run_r` takes exactly one R statement per call and refuses calls that have no approved effect contract. Write each multi-step check as one `local({ ... })` statement that prints every result it needs (a `local` block leaves nothing in the session). Use `for` loops with `cat()` or `print()` instead of `vapply`, `sapply` or `Filter` with a function argument, `duplicated()` instead of `anyDuplicated()`, a loop of `sum(g == level)` instead of `table()`, and `[["data"]]` instead of `$data` or `$labels`, because `$` followed by a name that is also a function (`data`, `labels`) is refused as higher-order flow. Do not name your own objects after base functions such as `raw`.

## Phase 1, source audit

Read the notebook with `read_project_file`. If it is open, also `read_open_document`: a dirty buffer means the
session ran code that disk does not hold, or the reverse. Diff them before trusting either.

Build the expected-object list. Column-0 assignments approximate top-level chunk output:
```r
local({
  src <- readLines("analysis.Rmd")
  print(unique(sub("\\s*<-.*$", "", grep("^[A-Za-z._][A-Za-z0-9._]*\\s*<-", src, value = TRUE))))
})
```
Map the batches from the same lines. A loop, or a helper defined once and called many times, is one code path
however many outputs it makes, and every later phase audits it once, on its first output (a second only where the
code branches, or where the first is blank or an error). A check whose answer depends on each unit's data (zero
events, degenerate fits, ranges, join fan-out, denominators, a per-unit HR, CI, p or N that feeds a claim) still
runs over every unit, as one loop inside one `run_r` call, not one read per output. The result is a reading list, not a
verdict: a name match can be a false hit. A helper passed by name (`lapply(genes, km_by_gene)`) shows in the line
numbers printed last, not in the per-helper counts, and a definition that is not at column 0 or uses `=` or `\(x)` is missed.
```r
local({
  src <- readLines("analysis.Rmd")
  fns <- sub("\\s*<-.*$", "", grep("^[A-Za-z._][A-Za-z0-9._]*\\s*<-\\s*function", src, value = TRUE))
  for (f in fns) cat(f, sum(grepl(paste0(f, "("), src, fixed = TRUE)), "\n")
  print(grep("\\bfor *\\(|apply\\(|Map\\(|\\bforeach\\(|\\b[pi]?map[_a-z0-9]*\\(|\\b[pi]?walk[0-9]*\\(|\\bgroup_map\\(", src))
})
```
Then scan for these classes. Each produced a wrong number without an error.

**Header `eval=` gates.** A header gate that resolves FALSE emits nothing: no output, no warning, no trace. A
skipped chunk and a chunk that ran and printed nothing are indistinguishable. List every header carrying
`eval=`; each is a silent-skip candidate. The fix is a body gate whose `else` says why:
`if (isTRUE(RUN_X)) { ... } else cat("chunk-label: skipped, RUN_X is FALSE\n")`.

**Duplicate `eval=` in one header.** knitr keeps the last copy, RStudio keeps the first, so the chunk behaves
differently knitted versus interactive. Lint every header (the split is a heuristic: a comma inside a quoted option value can fool it):
```r
local({
  src <- readLines("analysis.Rmd")
  hdr <- grep("^```\\{r", src, value = TRUE)
  opts <- sub("\\}\\s*$", "", sub("^```\\{r,?\\s*", "", hdr))
  for (i in seq_along(opts)) {
    nm <- sub("\\s*=.*$", "", strsplit(opts[i], ",\\s*(?=[A-Za-z._][A-Za-z0-9._]*\\s*=)", perl = TRUE)[[1]])
    if (any(duplicated(nm))) print(hdr[i])
  }
})
```

**Failure handlers nobody hears.** `tryCatch(error = function(e) message(...))` inside a chunk with
`message=FALSE` reports to nobody, and a handler returning bare NULL erases the reason. Grep `message(` inside
handlers and read the enclosing chunk options. Handlers `cat()` the unit name plus `conditionMessage(e)`.

**Tables keyed on the first non-NULL fit.** `Find(Negate(is.null), fits)` or `fits[[which(...)[1]]]` used to
pull labels or covariate sets for a whole table labels every panel with one exposure's model. Labels come from
the same list element as the estimate, keyed by name.

**A suffix regex selecting columns when a pooled aggregate shares the suffix.** `grep("\\.RS$", names(df))` also matches the `All.RS` / `All10.RS` roll-up written by the same helper, so a per-unit count silently includes the across-unit summary as extra units. It stays invisible while the affected value is only a tie-break. Select by membership against the known vector, `paste0(units, ".RS")`, with a `stopifnot(all(cols %in% names(df)))` beside it, so a renamed column fails loudly instead of being skipped.

Also flag: `coxph(`/`glm(`/`lm(` in a fig, plot or table chunk when an upstream chunk already fit it (two fits
drift; one model, one fit); `filterByExpr`, `calcNormFactors`, a subset or a join applied again downstream (two
universes, not comparable); a caption asserting a filter the code does not apply, such as "site-restricted
events" over a patient-level filter.


## Phase 4, data frame audit at element level

Dimensions are the start, not the check. One profile per frame that feeds a model, a figure or a table. Send a multi-step check as one `local({ ... })` statement and `cat()` or `print()` every result you need to see, because `local` returns only its last value:
```r
local({
  x <- as.data.frame(cohort_tbl)
  for (n in names(x)) {
    cat(n, paste(class(x[[n]]), collapse = "/"), "n_na", sum(is.na(x[[n]])), "n_unique", length(unique(x[[n]])), "\n")
    if (is.numeric(x[[n]])) cat("  range", min(x[[n]], na.rm = TRUE), max(x[[n]], na.rm = TRUE), "\n")
    if (is.character(x[[n]])) cat("  chr_not_num", sum(!is.na(x[[n]]) & is.na(suppressWarnings(as.numeric(x[[n]])))), "\n")
  }
})
```
Read it column by column with the domain in mind. Frames a helper builds per unit (a list of per-gene or
per-subgroup results) are one batch: profile the first in full, then compare the rest in one pass, one line per frame
(`frames` is the list of per-unit frames). A unit whose counts stand apart, or any non-zero `unused_levels`, is the next one
to profile.
```r
local({
  for (i in seq_along(frames)) {
    f <- frames[[i]]
    nl <- 0L
    for (n in names(f)) if ("factor" %in% class(f[[n]])) nl <- nl + sum(!(levels(f[[n]]) %in% as.character(f[[n]])))
    cat(names(frames)[i], "rows", nrow(f), "cols", length(f), "na", sum(is.na(f)), "unused_levels", nl, "\n")
  }
})
```
The Ranges and Keys and fan-out checks below still run over every frame in one pass, because their answer differs by unit.

- **Silent coercion.** `chr_not_num` small and positive on a column that should be numeric: a few `"<5"` or
  `"N/A"` strings turned the column to character, and a later `as.numeric` turned those rows into NA. Find
  them: `unique(v[!is.na(v) & is.na(suppressWarnings(as.numeric(v)))])`.
- **Ranges.** Age outside 0 to 110, a proportion outside [0, 1], a negative survival time (dates swapped), a
  count with a fractional part, `min == max` on a column meant to vary. An all-NA column is a join that matched
  nothing: `names(x)[apply(is.na(x), 2, sum) == nrow(x)]`.
- **Factor levels.** Unused levels give empty facets, zero-count rows, and a 1xK table that `chisq.test`
  silently turns into a goodness-of-fit test with a fabricated p. NA as a level and NA as a value behave
  differently in `table()` and in models.
```r
local({
  for (n in names(x)) if ("factor" %in% class(x[[n]])) print(list(col = n, unused = levels(x[[n]])[!(levels(x[[n]]) %in% unique(as.character(x[[n]])))], n_na = sum(is.na(x[[n]])), na_is_level = any(is.na(levels(x[[n]])))))
})
```
- **Keys and fan-out.** `sum(duplicated(x$patient_id))` on every frame that claims one row per patient. For every
  join: `nrow(left)`, `nrow(joined)`, `sum(duplicated(right$key))`. A non-unique right key multiplies rows, and a
  left join that grew is a finding unless the growth was intended.
- **Encoding and whitespace.** `"Male "` is not `"Male"`, and a non-breaking space or a curly quote breaks
  every `==` and `%in%`:
```r
local({
  for (n in names(x)) if (is.character(x[[n]])) cat(n, sum(grepl("^\\s|\\s$|[^ -~]", x[[n]])), "\n")
})
```
  Non-zero is a list to inspect, not automatically wrong; accented names are legitimate.
- **Dates.** `as.Date` returns NA for a bad format and says nothing, so parse failures hide inside "missing".
  `run_r` refuses `as.Date`, so count the strings that are not in `YYYY-MM-DD` form instead:
  `sum(!is.na(x$dx_date) & !grepl("^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$", x$dx_date))`. The pattern
  admits an impossible day such as Feb 30; for calendar validity, read the chunk's own parse output with
  `list_notebook_outputs` or ask the user to run `as.Date()` in their Console. Then
  `range(x$dx_date[grepl("^[0-9]{4}-", x$dx_date)])` (ISO strings sort in date order; for a column that is already a
  Date, `range(x$dx_date, na.rm = TRUE)`): 1900 or 2099 is a sentinel, not a date.

## Phase 5, provenance

An object existing says nothing about how it was made.

- Corrected matrices against their raw input. `identical()` FALSE is the floor; also report
  `c(cells_diff = sum(abs(m_cor - m_raw) > 0), frac = mean(abs(m_cor - m_raw) > 0), max_abs = max(abs(m_cor - m_raw)))`. A correction
  that returns its input unchanged looks exactly like success.
- Success flags the code sets (`combat_ok` and similar) are claims. Check the data.
- Caches: loaded rather than recomputed, key covering what it should, path in the tree you think it is. A
  fallback that substitutes raw counts when a worker dies produces a batch-confounded result, not an error.

## Phase 6, arithmetic, joins and fits

- Pooled cohorts against the sum of parts, with the right inequality.
- Proportions summing to 1, counts non-negative, denominators matching across tables that share a cohort.
- Gene universes: differing filters mean differing multiple-testing denominators.
- p in [0, 1]. Events never exceeding N. HR strictly positive, since HR is `exp(coef)`.

**Degenerate fits are the highest-yield check.** A Cox arm with zero events returns HR 0 or its reciprocal
near 6e7, CI `[0, Inf]`, p near 1. That is unestimable, not a strong effect.

```r
local({
  flag <- !is.na(hr_tbl$HR) & hr_tbl$conf.low <= 0 & !is.finite(hr_tbl$conf.high)
  print(sum(flag))
  print(hr_tbl[flag, c("cancer", "exposure", "n_events", "HR", "conf.low", "conf.high", "p")])
  print(sum(hr_tbl$n_events == 0 & !flag))
})
```
The last line counts misses; count false positives too. Fix: set HR and both CI bounds to NA and keep p, which
correctly reports no evidence. Then `na_col = "grey90"` draws the cell.

**One quantity computed twice with different denominators, both shipped.** A numerator built with `na.rm = TRUE` over a denominator of `nrow()` counts the NA rows the numerator dropped. When a second table computes the same percentage as `mean(flag, na.rm = TRUE)`, the two disagree by exactly the NA fraction and both land in one workbook, one on the bar and one in the adjacent sheet. Compare every percentage that appears in two places (`pct` is the shared column):
```r
local({
  m <- merge(sheet_a, sheet_b, by = keys, suffixes = c(".a", ".b"))
  print(sum(abs(m$pct.a - m$pct.b) > 1e-9, na.rm = TRUE))
})
```
Fix by computing it once on an `is.finite()` denominator and asserting the two agree.

**Metrics that can only come out one way.** `removeBatchEffect` removes a term by least squares; a QC that
regresses the PCs of the corrected matrix on that same term returns 0 by construction. Every number is correct
and the presentation is misleading. Test any QC metric on an input where it should fail: the uncorrected
matrix, or a batch variable the correction never saw. If it cannot fail, it is not a metric. Measure
`summary(lm(pc[, 1] ~ batch))$r.squared` on the raw matrix, the corrected one, and the corrected one against
a batch term the correction never used.

## Phase 7, figure audit

Verify each plotting code path plots what it is supposed to plot. The evidence is the plot object and the data
behind it, not the image. A loop or helper that draws many figures is one code path: check the FIRST figure's
object and image in full, then, where the code keeps the plots in a list, check the batch in one `run_r` over it
(for ggplot objects, `local({ for (i in seq_along(plots)) cat(i, nrow(plots[[i]][["data"]]), "\n") })`), never one redraw per figure. Where no list
is kept, run the per-unit data checks on the input data grouped by unit in one `run_r` (rows per unit, NA, zero
events, values outside the color breaks).

Mechanics first. Inspect already-existing `get_plot_history` entries and any independently available notebook
inline/cached output. An empty plot history says nothing about inline images in an R Markdown notebook. Record
which output stores are reachable and the image/source/run lineage you can verify; never infer a fresh render from
an old image. Do not redraw, rerun chunks or print plots merely because one store is empty. When an output is
unavailable, label that coverage partial and request explicit scoped execution authorization separately. An
existing blank first figure is a finding; inspect the next available representative without mutating the session.

For a ggplot object, read the plot object and its built layer data. `run_r` refuses `ggplot2::ggplot_build()`; `ggplot2::layer_data()` returns the same built data for one layer:
```r
local({
  print(p[["labels"]][c("title", "subtitle", "caption", "x", "y", "colour", "fill")])
  for (n in names(p[["mapping"]])) print(paste(n, deparse(p[["mapping"]][[n]])[1]))
  print(c(rows_in = nrow(p[["data"]])))
  for (i in seq_along(p[["layers"]])) {
    d <- ggplot2::layer_data(p, i)
    cat("layer", i, "rows drawn", nrow(d), "panels with no data:", levels(d[["PANEL"]])[!(levels(d[["PANEL"]]) %in% unique(d[["PANEL"]]))], "\n")
  }
  for (s in p[["scales"]][["scales"]]) print(list(aes = s[["aesthetics"]], limits = s[["limits"]]))
})
```
In recent ggplot2, `p[["labels"]]` holds only labels set explicitly and `ggplot2::get_labs(p)` returns the resolved axis labels.
- **Labels versus mapping.** The axis label must name the mapped variable or a transform of it. Three facets
  sharing one "PC1" label when each facet is an independent PCA hides that the axes are not comparable. Fix:
  per-panel variance explained in the strip, `sprintf("%s\nPC1 %.1f%%", cancer, ve1)`.
- **Dropped rows.** `rows_in` against rows drawn per layer, allowing for stat aggregation. A gap is NA removal
  or out-of-limits censoring, and neither prints under `warning=FALSE`.
- **Empty panels.** A PANEL in the layout with no data in any layer. Usually an unused level from Phase 4.
- **Clamped color scales.** `circlize::colorRamp2(c(0, 1, 2), ...)` paints every value outside the breaks at
  the end color, so an unestimable HR of 0 or 6e7 renders as the strongest result in the figure. Count them
  for breaks `c(0, 1, 2)` on matrix `m`, `c(below = sum(m < 0, na.rm = TRUE), above = sum(m > 2, na.rm = TRUE))`,
  then ask whether any is a degenerate fit from Phase 6. ggplot `scale_*_gradient(limits = )` with
  `oob = squish` clamps the same way; the default `censor` turns the value gray, which looks like what it is.
- **A pooled or total row sharing one scale with its own parts.** A "Pan-Cancer"/"All"/"Total" row is the sum
  of the rows under it, so on a shared axis it is several times the largest part and flattens every one of
  them to an unreadable stub. Measure the ratio before trusting the figure:
  `max(total[pooled]) / max(total[!pooled])`; anything past ~3 needs the pooled row in its own panel on its
  own scale, stacked with `patchwork::wrap_plots(p_pooled, p_parts, ncol = 1, heights = c(1, n_parts))`.
  Splitting has a second-order trap: any hard-coded label offset (`x = -20`, `x = total + 20`) was tuned to
  the shared range and is now wrong in both panels. Make the nudge a fraction of each panel's own maximum,
  `pad <- 0.02 * max(lp$total)`.
- **A composite slide reading a slot that was freed upstream.** Memory-management code (`r$voom <- NULL`,
  `r$dge <- NULL`, an `rm()` after a fit) silently removes what a later figure indexes, and `NULL$E[genes, ]`
  is an error, not a blank panel. Before adding or trusting any composite/summary figure, check every slot it
  reads still exists on every object it reads: `local({ for (n in names(objs)) cat(n, !is.null(objs[[n]][["voom"]]), "\n") })`. Where the
  slot is genuinely gone by design, draw the reason into the panel rather than letting `grid.grabExpr`
  capture an empty display list, which renders as half a blank page with nothing saying why.
- **A label naming a statistic the panel never computed.** "Dominant class" over `which.max(share - mean(share))`, or a facet strip reading "HR>1" over a stratum cut on a pooled Z. The computation is usually deliberate and defensible; the label is the part nobody revisited. Recompute the literal claim and count the disagreement: `sum(plotted_label != naive_label)`. Half the points disagreeing is normal for this class, because the two only coincide by accident. Rename to what is computed, or compute what the name says; both are one-line fixes and they are different scientific claims, so ask.
- **Legend versus data.** Legend keys are factor levels; the data may carry fewer.
  `levels(p[["data"]][["group"]])[!(levels(p[["data"]][["group"]]) %in% unique(p[["data"]][["group"]]))]` lists keys with nothing behind them. A count claimed in
  a subtitle is checked with `local({ g <- p[["data"]][["group"]]; for (l in unique(as.character(g))) cat(l, sum(g == l, na.rm = TRUE), "\n") })`.
- **Caption and subtitle claims.** Every number and assertion in `p[["labels"]]` is a claim about `p[["data"]]`.
  Recompute it. A subtitle saying "batch ellipses should collapse" over a panel where batch still explains
  38.1% of PC1 is wrong even though the plot is right. Figures state what they demonstrate, with the text
  computed from the same object: `subtitle = sprintf("batch R2 on PC1: %.1f%% (raw %.1f%%)", after, before)`.
- **ComplexHeatmap.** Two heatmaps sharing a `name` collide on the viewport and a `grid.grabExpr` replay comes
  back blank, warning hidden. Names unique per grab.

Do not make text-level claims from the returned image. It is downscaled, and an interactive redraw uses a
different device than the chunk's `fig.width`. Truncation in a preview is usually the narrow device. Say what
was verified from the object and what was inferred from the picture.

## Phase 8, table audit

Every table-building code path, cross-checked against the object it was built from. `get_viewer_state` reports
only whether the Viewer is active and bounded kind metadata, never its cells, and printing a table widget in the
Console only renders it to the Viewer again. Read the cells through `run_r` instead: `as.data.frame(tbl)` for gt
and gtsummary, `w[["x"]][["data"]]` for a DT widget, the frame itself otherwise. A loop or helper that builds many tables is
one code path: read the first table in full, then check the rest in one `run_r` (rows, N against the cohort
object, and the unique-label count below, per table), never one re-render each. Any per-unit HR, CI, p or N that
feeds a claim is checked across every table in that same `run_r`.

- Row count against `nrow()` of the source object. `head()` or `slice_head()` in a table chunk truncates silently.
- A label column with one unique value across rows that should differ, the signature of the first-non-NULL
  key bug: `local({ for (n in names(tbl)) cat(n, length(unique(tbl[[n]])), "\n") })`.
- Header against content: a renamed header over a column that was not moved, `HR` over `exp(-coef)`.
- Rounding: `round(p, 2)` turns 0.049 into 0.05 and crosses a threshold in the reader's eye; `signif(p, 2)`
  does not. Check the formatter, not the number.
- Denominators: N in the table against N in the cohort object; percentages summing to 100 within each group.
- The covariate set printed in a table or panel against the stored fit:
  `local({ for (n in names(fits)) print(names(coef(fits[[n]]))) })`.

## Phase 9, claims against measurement

The highest-value phase, and the one usually skipped. Read what captions, subtitles, headers and prose assert,
then measure whether the session supports each one. A subtitle is a testable claim. So is "adjusted for age,
sex and stage" against `names(coef(fit))`, and a "cache loaded" line against the path it names. A correct
number under a wrong sentence is a finding.
