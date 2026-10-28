test_that("captured workspace defaults use selected defining-frame callable identity", {
  fx <- aut_fixture()
  ref <- new.env(parent=emptyenv());ref$value <- 2L
  fake <- new.env(parent=baseenv());fake$aggregate <- function(...) ref
  attr(fake,"name") <- "package:stats";lockBinding("aggregate",fake)
  shadow <- new.env(parent=baseenv());shadow$aggregate <- function(...) ref
  activeCount <- promiseCount <- 0L
  active <- new.env(parent=baseenv())
  makeActiveBinding("aggregate",function(){activeCount <<- activeCount+1L;stop("GETTER_EXECUTED")},active)
  promise <- new.env(parent=baseenv())
  delayedAssign("aggregate",{promiseCount <<- promiseCount+1L;stop("PROMISE_EXECUTED")},assign.env=promise)
  genuine <- new.env(parent=baseenv());genuine$aggregate <- stats::aggregate
  environments <- list(fake,shadow,active,promise,genuine)
  names <- paste0("rai_fx_authority_",seq_along(environments))
  for(i in seq_along(environments)) {
    helper <- function(y=aggregate(1L,by=list(1L),FUN=mean)) { y$value <- 99L }
    environment(helper) <- environments[[i]];assign(names[[i]],helper,globalenv())
  }
  snapshot <- aut_snapshot_with_identity()
  for(name in names) assign(name,snapshot$identities[[match(name,snapshot$names)]],aut_get(".rs.rai.dataState")$derived)
  for(i in seq_along(names)) {
    result <- aut_get(".rs.rai.dataGuard")(parse(text=paste0(names[[i]],"()"))[[1L]],snapshot)
    expect_identical(result$ok,i==5L)
  }
  for(code in c('aggregate(1L,by=list(1L),FUN=mean)','stats::aggregate(1L,by=list(1L),FUN=mean)',
               'ave(1L,FUN=mean)','stats::ave(1L,FUN=mean)'))
    expect_true(aut_get(".rs.rai.dataGuard")(parse(text=code)[[1L]],snapshot)$ok)
  expect_identical(activeCount,0L);expect_identical(promiseCount,0L)
  expect_identical(ref$value,2L);expect_length(fx$events$items,0L)
})

# Owning-session tests: NEVER replace this callback with a boolean adapter.
# A standalone R process fails native availability; it is not rsession proof.
test_that("realized callable identity requires the registered owning native callback", {
  expect_true(is.loaded("rs_raiRealizedBindingIdentity", PACKAGE="(embedding)"))
})

test_that("realized callable authority rejects captures without forcing and preserves aliases", {
  same <- function(env, name, reference)
    .Call("rs_raiRealizedBindingIdentity", env, name, reference, PACKAGE="(embedding)")
  canonical <- baseenv()
  owned <- new.env(parent=emptyenv())
  owned$identity <- base::identity
  expect_true(same(owned, "identity", canonical))
  expect_identical(environment(owned$identity), environment(base::identity))
  owned$sum <- base::sum
  expect_true(same(owned, "sum", canonical))
  delayedAssign("identity", base::identity, assign.env=owned)
  expect_false(same(owned, "identity", canonical))
  invisible(owned$identity) # Trusted positive fixture realization only.
  expect_true(same(owned, "identity", canonical))
  owned$identity <- function(x) x
  attr(owned, "name") <- "package:base"
  lockBinding("identity", owned)
  expect_false(same(owned, "identity", canonical))
  activeCount <- promiseCount <- 0L
  active <- new.env(parent=emptyenv())
  makeActiveBinding("identity", function() { activeCount <<- activeCount+1L; stop("GETTER_EXECUTED") }, active)
  promise <- new.env(parent=emptyenv())
  delayedAssign("identity", { promiseCount <<- promiseCount+1L; stop("PROMISE_EXECUTED") }, assign.env=promise)
  expect_false(same(active, "identity", canonical))
  expect_false(same(promise, "identity", canonical))
  expect_false(same(canonical, "identity", active))
  expect_false(same(canonical, "identity", promise))
  expect_identical(activeCount, 0L)
  expect_identical(promiseCount, 0L)
})
