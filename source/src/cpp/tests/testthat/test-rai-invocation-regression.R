test_that("R43 reviewed effects and callback contracts have minimal policy-only controls", {
 fx <- aut_fixture();ref <- new.env(parent=emptyenv());ref$value <- 2L
 assign("rai_fx_r43_ref",ref,globalenv());assign("rai_fx_r43_x",ref,globalenv())
 cap <- new.env(parent=baseenv());cap$callback <- function(x) { ref$value <- 99L; x }
 assign("rai_fx_r43_maker",eval(quote(function() callback),cap),globalenv())
 assign("rai_fx_r43_mutator",function(x) { x$value <- 99L },globalenv())
 setup <- aut_queue('rai_fx_r43_saved <- data.frame(value=1L)');expect_identical(setup$status,"queued")
 if(identical(setup$status,"queued")) expect_identical(aut_execute(setup$run_id)$status,"ok")
 snapshot <- aut_snapshot_with_identity()
 diagnostics <- lapply(c("mean","aggregate","identity","data.frame"),function(name) {
  environment <- globalenv();path <- character(0)
  for(i in seq_len(64L)) {
   path <- c(path,environmentName(environment))
   if(exists(name,envir=environment,inherits=FALSE) || identical(environment,emptyenv())) break
   environment <- parent.env(environment)
  }
  package <- if(identical(name,"aggregate"))"stats" else "base"
  core <- get(name,asNamespace(package),inherits=FALSE)
  captured <- do.call(substitute,list(as.name(name),environment))
  list(name=name,path=path,captured_type=typeof(captured),core_type=typeof(core),equal_core=identical(captured,core),namespace_environment=identical(environment,asNamespace(package)))
 })
 cat("RAI_R44_LOOKUP_DIAGNOSTIC ",jsonlite::toJSON(diagnostics,auto_unbox=TRUE),"\n",sep="")
 assign("rai_fx_r43_maker",snapshot$identities[[match("rai_fx_r43_maker",snapshot$names)]],aut_get(".rs.rai.dataState")$derived)
 negative <- c(
  'local({ f <- function(rai_fx_r43_x,y=rai_fx_r43_x) { (rm(rai_fx_r43_x)); y }; a <- f(data.frame(value=1L)); a$value <- 99L })',
  'local({ f <- function(x,y=x) { for(x in list(rai_fx_r43_ref)) {}; y }; a <- f(data.frame(value=1L)); a$value <- 99L })',
  'local({ x <- data.frame(value=1L); f <- function(y,z) { force(z); y$value <- 99L }; f(x,x <- rai_fx_r43_ref) })',
  'stats::aggregate(1L,by=list(1L),FUN=rai_fx_r43_maker())',
  'aggregate(1L,by=list(1L),FUN=rai_fx_r43_maker())',
  'stats::ave(1L,FUN=rai_fx_r43_maker())',
  'base::lapply(list(rai_fx_r43_ref),"rai_fx_r43_mutator")')
 positive <- c(
  'local({ f <- function(x) { (rm(x)); data.frame(value=1L) }; a <- f(1L); a$value <- 3L })',
  'local({ f <- function(x,y=x) { for(x in list(data.frame(value=1L))) {}; y }; a <- f(data.frame(value=1L)); a$value <- 3L })',
  'local({ x <- data.frame(value=1L); f <- function(y,z) { force(z); y$value <- 3L; y }; f(x,1L) })',
  'stats::aggregate(1L,by=list(1L),FUN=mean)',
  'aggregate(1L,by=list(1L),FUN=mean)',
  'base::lapply(list(rai_fx_r43_ref),base::identity)',
  'local({ f <- function(rai_fx_r43_saved) { rm(rai_fx_r43_saved); data.frame(value=1L) }; a <- f(1L); a$value <- 3L })')
 results <- lapply(c(negative,positive),function(code) aut_get(".rs.rai.dataGuard")(parse(text=code)[[1L]],snapshot))
 cat("RAI_R43_CURRENT_REVIEW_RECEIPT ",jsonlite::toJSON(list(negative=negative,positive=positive,policy_ok=vapply(results,function(x)x$ok,logical(1L)),reason=lapply(results,function(x)x$reason),suspected_mutation_executed=FALSE),auto_unbox=TRUE),"\n",sep="")
 labels <- c("wrapped removal","loop iterator","supplied promise effect","qualified generic callback","unqualified generic callback","stats direct callback","string helper selector",
  "wrapped fresh return","fresh iterator","pure supplied arguments","qualified readonly mean","unqualified readonly mean","qualified readonly identity","local fresh shadow cleanup")
 expected <- c(rep(FALSE,length(negative)),rep(TRUE,length(positive)))
 for(i in seq_along(results)) {
  cat("RAI_R44_CASE ",jsonlite::toJSON(list(label=labels[[i]],code=c(negative,positive)[[i]],expected=expected[[i]],actual=results[[i]]$ok,reason=results[[i]]$reason,mutation_executed=FALSE),auto_unbox=TRUE),"\n",sep="")
  expect_identical(results[[i]]$ok,expected[[i]],info=labels[[i]])
  expect_false(grepl("could not classify",if(is.null(results[[i]]$reason))"" else results[[i]]$reason,fixed=TRUE),info=labels[[i]])
 }
 expect_identical(ref$value,2L)
})

test_that("R43 attached namespace labels grant no captured canonical authority", {
 fx <- aut_fixture();ref <- new.env(parent=emptyenv());ref$value <- 2L
 fake <- new.env(parent=baseenv());fake$identity <- function(...) ref
 attached <- attach(fake,pos=2L,name="package:stats")
 on.exit(detach(2L),add=TRUE);lockBinding("identity",attached)
 assign("rai_fx_r43_fake_core",eval(quote(function(y=identity(data.frame(value=1L))) { y$value <- 99L }),attached),globalenv())
 snapshot <- aut_snapshot_with_identity()
 assign("rai_fx_r43_fake_core",snapshot$identities[[match("rai_fx_r43_fake_core",snapshot$names)]],aut_get(".rs.rai.dataState")$derived)
 result <- aut_get(".rs.rai.dataGuard")(quote(rai_fx_r43_fake_core()),snapshot)
 cat("RAI_R44_CASE ",jsonlite::toJSON(list(label="counterfeit attached trust",expected=FALSE,actual=result$ok,reason=result$reason,mutation_executed=FALSE),auto_unbox=TRUE),"\n",sep="")
 expect_false(result$ok);expect_false(grepl("could not classify",if(is.null(result$reason))"" else result$reason,fixed=TRUE))
 expect_identical(ref$value,2L)
})

test_that("R46 realized selected bindings prove canonical identity without forcing captures", {
 fx <- aut_fixture(); ref <- new.env(parent=emptyenv()); ref$value <- 2L
 assign("rai_fx_r46_ref",ref,globalenv())
 same <- function(environment,name="aggregate",reference=asNamespace("stats"))
  .Call("rs_raiRealizedBindingIdentity",environment,name,reference,PACKAGE="(embedding)")
 metadataCase <- function(label,environment,expected,name="aggregate",reference=asNamespace("stats")) {
  actual <- same(environment,name,reference)
  cat("RAI_R46_METADATA_CASE ",jsonlite::toJSON(list(label=label,expected=expected,actual=actual,mutation_executed=FALSE),auto_unbox=TRUE),"\n",sep="")
  expect_identical(actual,expected,info=label)
 }
 metadataCase("genuine attached aggregate",as.environment("package:stats"),TRUE)
 metadataCase("genuine attached predict",as.environment("package:stats"),TRUE,name="predict")
 fake <- new.env(parent=baseenv());fake$aggregate <- function(...) ref
 attr(fake,"name") <- "package:stats";lockBinding("aggregate",fake)
 metadataCase("fake label locked callable impostor",fake,FALSE)
 shadow <- new.env(parent=baseenv());shadow$aggregate <- function(...) ref
 metadataCase("caller shadow",shadow,FALSE)
 owned <- new.env(parent=baseenv());owned$aggregate <- stats::aggregate
 metadataCase("genuine realized owned alias",owned,TRUE)
 owned$aggregate <- function(...) ref
 metadataCase("stale rebinding",owned,FALSE)
 activeCount <- 0L;active <- new.env(parent=baseenv())
 makeActiveBinding("aggregate",function(){activeCount <<- activeCount+1L;stop("R46_ACTIVE_GETTER_EXECUTED")},active)
 metadataCase("active getter refused",active,FALSE)
 promiseCount <- 0L;promise <- new.env(parent=baseenv())
 delayedAssign("aggregate",{promiseCount <<- promiseCount+1L;stop("R46_PROMISE_EXECUTED")},eval.env=environment(),assign.env=promise)
 metadataCase("unforced promise refused",promise,FALSE)
 metadataCase("unforced reference refused",as.environment("package:stats"),FALSE,reference=promise)
 metadataCase("active reference refused",as.environment("package:stats"),FALSE,reference=active)
 owned$aggregate <- 1L;metadataCase("noncallable refused",owned,FALSE)
 for(spec in list(list(name="rai_fx_r46_fake",environment=fake),list(name="rai_fx_r46_shadow",environment=shadow),list(name="rai_fx_r46_active",environment=active),list(name="rai_fx_r46_promise",environment=promise)))
  assign(spec$name,eval(quote(function(y=aggregate(1L,by=list(1L),FUN=mean)) { y$value <- 99L }),spec$environment),globalenv())
 snapshot <- aut_snapshot_with_identity()
 for(name in c("rai_fx_r46_fake","rai_fx_r46_shadow","rai_fx_r46_active","rai_fx_r46_promise"))
  assign(name,snapshot$identities[[match(name,snapshot$names)]],aut_get(".rs.rai.dataState")$derived)
 cases <- list(
  list(label="genuine unqualified aggregate preserved",expected=TRUE,code='aggregate(1L,by=list(1L),FUN=mean)'),
  list(label="genuine qualified aggregate preserved",expected=TRUE,code='stats::aggregate(1L,by=list(1L),FUN=mean)'),
  list(label="genuine unqualified ave preserved",expected=TRUE,code='ave(1L,FUN=mean)'),
  list(label="genuine qualified ave preserved",expected=TRUE,code='stats::ave(1L,FUN=mean)'),
  list(label="fake locked label default",expected=FALSE,code='rai_fx_r46_fake()'),
  list(label="caller shadow default",expected=FALSE,code='rai_fx_r46_shadow()'),
  list(label="active default no evaluation",expected=FALSE,code='rai_fx_r46_active()'),
  list(label="promise default no evaluation",expected=FALSE,code='rai_fx_r46_promise()'),
  list(label="stale supplied-default binding",expected=FALSE,code='local({ f <- function(x,y=x) { x <- rai_fx_r46_ref; y }; a <- f(data.frame(value=1L)); a$value <- 99L })'),
  list(label="genuine readonly identity preserved",expected=TRUE,code='base::lapply(list(rai_fx_r46_ref),identity)'))
 for(case in cases) {
  policy <- aut_get(".rs.rai.dataGuard")(parse(text=case$code)[[1L]],snapshot)
  cat("RAI_R46_POLICY_CASE ",jsonlite::toJSON(list(label=case$label,code=case$code,expected=case$expected,actual=policy$ok,reason=policy$reason,mutation_executed=FALSE),auto_unbox=TRUE),"\n",sep="")
  expect_identical(policy$ok,case$expected,info=case$label)
 }
 expect_identical(activeCount,0L);expect_identical(promiseCount,0L)
 expect_identical(ref$value,2L);expect_length(fx$events$items,0L)
 cat("RAI_R46_NONFORCING_COUNTERS ",jsonlite::toJSON(list(active=activeCount,promise=promiseCount,protected_value=ref$value,protected_mutations_executed=FALSE),auto_unbox=TRUE),"\n",sep="")
})

test_that("R48 shared transfer contracts preserve ordered effects zero entries and forwarded callbacks", {
 fx <- aut_fixture();ref <- new.env(parent=emptyenv());ref$value <- 2L
 assign("rai_fx_r48_ref",ref,globalenv())
 assign("rai_fx_r48_mutator",function(x) { x$value <- 99L },globalenv())
 assign("rai_fx_r48_h",eval(quote(function(x) lapply(x,identity)),baseenv()),globalenv())
 assign("rai_fx_r48_forwarded_h",eval(quote(function(x) do.call("lapply",list(x,identity))),baseenv()),globalenv())
 snapshot <- aut_snapshot_with_identity()
 for(name in c("rai_fx_r48_h","rai_fx_r48_forwarded_h"))
  assign(name,snapshot$identities[[match(name,snapshot$names)]],aut_get(".rs.rai.dataState")$derived)
 cases <- list(
  list(label="sibling stale default",code="local({ f <- function(x,y=x) { list({x <- rai_fx_r48_ref; 0L},y)[[2L]] }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,contracts=c("sibling")),
  list(label="sibling fresh default",code="local({ f <- function(x,y=x) { list({x <- data.frame(value=2L); 0L},y)[[2L]] }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,contracts=c("sibling")),
  list(label="zero iterator protected entry",code="local({ f <- function(x) { for(x in list()) {}; x }; a <- f(rai_fx_r48_ref); a$value <- 99L })",expected=FALSE,contracts=c("zero")),
  list(label="zero iterator fresh entry",code="local({ f <- function(x) { for(x in list()) {}; x }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,contracts=c("zero")),
  list(label="nonempty iterator proves replacement",code="local({ f <- function(x) { for(x in list(data.frame(value=2L))) {}; x }; a <- f(rai_fx_r48_ref); a$value <- 3L })",expected=TRUE,contracts=c("zero")),
  list(label="forwarded mutator selector",code="base::do.call(\"lapply\",list(list(rai_fx_r48_ref),\"rai_fx_r48_mutator\"))",expected=FALSE,contracts=c("forward")),
  list(label="forwarded readonly callback",code="base::do.call(\"lapply\",list(list(rai_fx_r48_ref),base::identity))",expected=TRUE,contracts=c("forward")),
  list(label="symbol forwarded readonly callback",code="do.call(lapply,list(list(1L),identity))",expected=TRUE,contracts=c("forward")),
  list(label="forwarded opaque target",code="local({ target <- \"lapply\"; do.call(target,list(list(rai_fx_r48_ref),\"rai_fx_r48_mutator\")) })",expected=FALSE,contracts=c("forward")),
  list(label="forwarded quoted arguments",code="base::do.call(\"lapply\",list(list(rai_fx_r48_ref),\"rai_fx_r48_mutator\"),quote=TRUE)",expected=FALSE,contracts=c("forward")),
  list(label="forwarded explicit environment",code="base::do.call(\"lapply\",list(list(rai_fx_r48_ref),\"rai_fx_r48_mutator\"),envir=baseenv())",expected=FALSE,contracts=c("forward")),
  list(label="sibling then zero protected",code="local({ f <- function(x,y=x) { list({x <- rai_fx_r48_ref; 0L},{for(x in list()) {}; x})[[2L]] }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,contracts=c("sibling","zero")),
  list(label="zero then sibling protected",code="local({ f <- function(x,y=x) { for(x in list()) {}; list({x <- rai_fx_r48_ref; 0L},y)[[2L]] }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,contracts=c("zero","sibling")),
  list(label="sibling inside forwarding protected",code="local({ f <- function(x,y=x) { base::do.call(\"list\",list({x <- rai_fx_r48_ref; 0L},y))[[2L]] }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,contracts=c("sibling","forward")),
  list(label="forwarding inside sibling protected",code="local({ f <- function(x,y=x) { list(base::do.call(\"identity\",list({x <- rai_fx_r48_ref; 0L})),y)[[2L]] }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,contracts=c("forward","sibling")),
  list(label="zero then forwarding protected",code="local({ f <- function(x) { for(x in list()) {}; base::do.call(\"identity\",list(x)) }; a <- f(rai_fx_r48_ref); a$value <- 99L })",expected=FALSE,contracts=c("zero","forward")),
  list(label="zero inside forwarding protected",code="local({ f <- function(x) { base::do.call(\"identity\",list({for(x in list()) {}; x})) }; a <- f(rai_fx_r48_ref); a$value <- 99L })",expected=FALSE,contracts=c("forward","zero")),
  list(label="sibling then zero fresh",code="local({ f <- function(x,y=x) { list({x <- data.frame(value=2L); 0L},{for(x in list()) {}; x})[[2L]] }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,contracts=c("sibling","zero")),
  list(label="zero then sibling fresh",code="local({ f <- function(x,y=x) { for(x in list()) {}; list({x <- data.frame(value=2L); 0L},y)[[2L]] }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,contracts=c("zero","sibling")),
  list(label="sibling inside forwarding fresh",code="local({ f <- function(x,y=x) { base::do.call(\"list\",list({x <- data.frame(value=2L); 0L},y))[[2L]] }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,contracts=c("sibling","forward")),
  list(label="forwarding inside sibling fresh",code="local({ f <- function(x,y=x) { list(base::do.call(\"identity\",list({x <- data.frame(value=2L); 0L})),y)[[2L]] }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,contracts=c("forward","sibling")),
  list(label="zero then forwarding fresh",code="local({ f <- function(x) { for(x in list()) {}; base::do.call(\"identity\",list(x)) }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,contracts=c("zero","forward")),
  list(label="zero inside forwarding fresh",code="local({ f <- function(x) { base::do.call(\"identity\",list({for(x in list()) {}; x})) }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,contracts=c("forward","zero")),
  list(label="unknown order cannot prove fresh",code="local({ f <- function(x,y=x) { unknown_order({x <- rai_fx_r48_ref; 0L},y) }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,contracts=c("sibling","unknown")),
  list(label="canonical callback role in owned closed helper",code="rai_fx_r48_h(list(1L))",expected=TRUE,contracts=c("callback")),
  list(label="canonical callback role in owned forwarded helper",code="rai_fx_r48_forwarded_h(list(1L))",expected=TRUE,contracts=c("callback","forward")),
  list(label="forwarded literal approved helper",code="local({ f <- function(x) x; a <- base::do.call(f,list(data.frame(value=1L))); a$value <- 3L })",expected=TRUE,contracts=c("forward","helper")))
 for(item in cases) {
  result <- aut_get(".rs.rai.dataGuard")(parse(text=item$code)[[1L]],snapshot)
  item$actual <- result$ok;item$reason <- result$reason;item$mutation_executed <- FALSE
  cat("RAI_R48_TRANSFER_CASE ",jsonlite::toJSON(item,auto_unbox=TRUE),"\n",sep="")
  expect_identical(result$ok,item$expected,info=item$label)
  expect_false(grepl("could not classify",if(is.null(result$reason))"" else result$reason,fixed=TRUE),info=item$label)
 }
 cat("RAI_R48_PROTECTED_COUNTER ",jsonlite::toJSON(list(value=ref$value,mutation_executed=FALSE),auto_unbox=TRUE),"\n",sep="")
 expect_identical(ref$value,2L)
})

test_that("R49 two-stage forwarding materializes before target and callback dispatch", {
 fx <- aut_fixture();ref <- new.env(parent=emptyenv());ref$value <- 2L
 assign("rai_fx_r49_ref",ref,globalenv())
 assign("rai_fx_r49_box",list(function(x)ref),globalenv())
 # r48 exact reproducer uses a distinct captured original reference.
 assign("rai_fx_r48_target_ref",ref,globalenv())
 snapshot <- aut_snapshot_with_identity()
 cases <- list(
 list(label="target string pure shadow",code="local({ f <- function(z) { identity <- function(x) rai_fx_r49_ref;base::do.call(\"identity\",list(data.frame(value=1L))) }; a <- f(1L); a$value <- 99L })",expected=FALSE,axes="{\"target_kind\": \"string\", \"arguments\": \"pure\", \"rebinding\": \"shadow\"}"),
 list(label="target string pure container",code="local({ f <- function(z) { identity <- rai_fx_r49_box[[1L]];base::do.call(\"identity\",list(data.frame(value=1L))) }; a <- f(1L); a$value <- 99L })",expected=FALSE,axes="{\"target_kind\": \"string\", \"arguments\": \"pure\", \"rebinding\": \"container\"}"),
 list(label="target string effectful shadow",code="local({ f <- function(z) { base::do.call(\"identity\",list({identity <- function(x) rai_fx_r49_ref;data.frame(value=1L)})) }; a <- f(1L); a$value <- 99L })",expected=FALSE,axes="{\"target_kind\": \"string\", \"arguments\": \"effectful\", \"rebinding\": \"shadow\"}"),
 list(label="target string effectful container",code="local({ f <- function(z) { base::do.call(\"identity\",list({identity <- rai_fx_r49_box[[1L]];data.frame(value=1L)})) }; a <- f(1L); a$value <- 99L })",expected=FALSE,axes="{\"target_kind\": \"string\", \"arguments\": \"effectful\", \"rebinding\": \"container\"}"),
 list(label="target function pure shadow",code="local({ f <- function(z) { identity <- function(x) rai_fx_r49_ref;base::do.call(base::identity,list(data.frame(value=1L))) }; a <- f(1L); a$value <- 99L })",expected=TRUE,axes="{\"target_kind\": \"function\", \"arguments\": \"pure\", \"rebinding\": \"shadow\"}"),
 list(label="target function pure container",code="local({ f <- function(z) { identity <- rai_fx_r49_box[[1L]];base::do.call(base::identity,list(data.frame(value=1L))) }; a <- f(1L); a$value <- 99L })",expected=TRUE,axes="{\"target_kind\": \"function\", \"arguments\": \"pure\", \"rebinding\": \"container\"}"),
 list(label="target function effectful shadow",code="local({ f <- function(z) { base::do.call(base::identity,list({identity <- function(x) rai_fx_r49_ref;data.frame(value=1L)})) }; a <- f(1L); a$value <- 99L })",expected=TRUE,axes="{\"target_kind\": \"function\", \"arguments\": \"effectful\", \"rebinding\": \"shadow\"}"),
 list(label="target function effectful container",code="local({ f <- function(z) { base::do.call(base::identity,list({identity <- rai_fx_r49_box[[1L]];data.frame(value=1L)})) }; a <- f(1L); a$value <- 99L })",expected=TRUE,axes="{\"target_kind\": \"function\", \"arguments\": \"effectful\", \"rebinding\": \"container\"}"),
 list(label="callback string pure string",code="local({ identity <- rai_fx_r49_box[[1L]];base::do.call(\"lapply\",list(X=list(1L),FUN=\"identity\")) })",expected=FALSE,axes="{\"target_kind\": \"string\", \"arguments\": \"pure\", \"callback_kind\": \"string\", \"rebinding\": \"container\"}"),
 list(label="callback string pure function",code="local({ identity <- rai_fx_r49_box[[1L]];base::do.call(\"lapply\",list(X=list(1L),FUN=base::identity)) })",expected=TRUE,axes="{\"target_kind\": \"string\", \"arguments\": \"pure\", \"callback_kind\": \"function\", \"rebinding\": \"container\"}"),
 list(label="callback string effectful string",code="local({ base::do.call(\"lapply\",list(X={identity <- rai_fx_r49_box[[1L]];list(1L)},FUN=\"identity\")) })",expected=FALSE,axes="{\"target_kind\": \"string\", \"arguments\": \"effectful\", \"callback_kind\": \"string\", \"rebinding\": \"container\"}"),
 list(label="callback string effectful function",code="local({ base::do.call(\"lapply\",list(X={identity <- rai_fx_r49_box[[1L]];list(1L)},FUN=base::identity)) })",expected=TRUE,axes="{\"target_kind\": \"string\", \"arguments\": \"effectful\", \"callback_kind\": \"function\", \"rebinding\": \"container\"}"),
 list(label="callback function pure string",code="local({ identity <- rai_fx_r49_box[[1L]];base::do.call(base::lapply,list(X=list(1L),FUN=\"identity\")) })",expected=FALSE,axes="{\"target_kind\": \"function\", \"arguments\": \"pure\", \"callback_kind\": \"string\", \"rebinding\": \"container\"}"),
 list(label="callback function pure function",code="local({ identity <- rai_fx_r49_box[[1L]];base::do.call(base::lapply,list(X=list(1L),FUN=base::identity)) })",expected=TRUE,axes="{\"target_kind\": \"function\", \"arguments\": \"pure\", \"callback_kind\": \"function\", \"rebinding\": \"container\"}"),
 list(label="callback function effectful string",code="local({ base::do.call(base::lapply,list(X={identity <- rai_fx_r49_box[[1L]];list(1L)},FUN=\"identity\")) })",expected=FALSE,axes="{\"target_kind\": \"function\", \"arguments\": \"effectful\", \"callback_kind\": \"string\", \"rebinding\": \"container\"}"),
 list(label="callback function effectful function",code="local({ base::do.call(base::lapply,list(X={identity <- rai_fx_r49_box[[1L]];list(1L)},FUN=base::identity)) })",expected=TRUE,axes="{\"target_kind\": \"function\", \"arguments\": \"effectful\", \"callback_kind\": \"function\", \"rebinding\": \"container\"}"),
 list(label="default string pure fresh",code="local({ f <- function(x,y=x) y; a <- base::do.call(\"f\",list(x=data.frame(value=1L))); a$value <- 99L })",expected=TRUE,axes="{\"target_kind\": \"string\", \"arguments\": \"pure\", \"default_dependency\": true, \"lineage\": \"fresh\"}"),
 list(label="default string pure protected",code="local({ f <- function(x,y=x) y; a <- base::do.call(\"f\",list(x=rai_fx_r49_ref)); a$value <- 99L })",expected=FALSE,axes="{\"target_kind\": \"string\", \"arguments\": \"pure\", \"default_dependency\": true, \"lineage\": \"protected\"}"),
 list(label="default string effectful fresh",code="local({ f <- function(x,y=x) y; a <- base::do.call(\"f\",list(x={z <- 2L;data.frame(value=1L)})); a$value <- 99L })",expected=TRUE,axes="{\"target_kind\": \"string\", \"arguments\": \"effectful\", \"default_dependency\": true, \"lineage\": \"fresh\"}"),
 list(label="default string effectful protected",code="local({ f <- function(x,y=x) y; a <- base::do.call(\"f\",list(x={z <- 2L;rai_fx_r49_ref})); a$value <- 99L })",expected=FALSE,axes="{\"target_kind\": \"string\", \"arguments\": \"effectful\", \"default_dependency\": true, \"lineage\": \"protected\"}"),
 list(label="default function pure fresh",code="local({ f <- function(x,y=x) y; a <- base::do.call(f,list(x=data.frame(value=1L))); a$value <- 99L })",expected=TRUE,axes="{\"target_kind\": \"function\", \"arguments\": \"pure\", \"default_dependency\": true, \"lineage\": \"fresh\"}"),
 list(label="default function pure protected",code="local({ f <- function(x,y=x) y; a <- base::do.call(f,list(x=rai_fx_r49_ref)); a$value <- 99L })",expected=FALSE,axes="{\"target_kind\": \"function\", \"arguments\": \"pure\", \"default_dependency\": true, \"lineage\": \"protected\"}"),
 list(label="default function effectful fresh",code="local({ f <- function(x,y=x) y; a <- base::do.call(f,list(x={z <- 2L;data.frame(value=1L)})); a$value <- 99L })",expected=TRUE,axes="{\"target_kind\": \"function\", \"arguments\": \"effectful\", \"default_dependency\": true, \"lineage\": \"fresh\"}"),
 list(label="default function effectful protected",code="local({ f <- function(x,y=x) y; a <- base::do.call(f,list(x={z <- 2L;rai_fx_r49_ref})); a$value <- 99L })",expected=FALSE,axes="{\"target_kind\": \"function\", \"arguments\": \"effectful\", \"default_dependency\": true, \"lineage\": \"protected\"}"),
 list(label="r48 exact container late target RED",code="local({ f <- function(x) { base::do.call(\"identity\",list({ identity <- rai_fx_r49_box[[1L]]; data.frame(value=1L) })) }; a <- f(1L); a$value <- 99L })",expected=FALSE,axes="{\"target_kind\": \"string\", \"arguments\": \"effectful\", \"rebinding\": \"container\", \"current_red\": true}"),
 list(label="captured alias preserves independent binding",code="local({ k <- base::identity; a <- do.call(k,list({identity <- rai_fx_r49_box[[1L]];data.frame(value=1L)})); a$value <- 3L })",expected=TRUE,axes="{\"target_kind\": \"function\", \"arguments\": \"effectful\", \"rebinding\": \"other_name\"}"),
 list(label="symbol target itself rebound after args",code="local({ identity <- base::identity; a <- do.call(identity,list({identity <- rai_fx_r49_box[[1L]];data.frame(value=1L)})); a$value <- 99L })",expected=FALSE,axes="{\"target_kind\": \"function\", \"arguments\": \"effectful\", \"rebinding\": \"same_name\"}"),
 list(label="captured callback precedes data rebinding",code="local({ identity <- base::identity; do.call(\"lapply\",list(FUN=identity,X={identity <- rai_fx_r49_box[[1L]];list(1L)})) })",expected=TRUE,axes="{\"callback_kind\": \"function\", \"arguments\": \"effectful\", \"callback_materialized_before_effect\": true}"),
 list(label="callback selector resolves after data rebinding",code="local({ do.call(\"lapply\",list(FUN=\"identity\",X={identity <- rai_fx_r49_box[[1L]];list(1L)})) })",expected=FALSE,axes="{\"callback_kind\": \"string\", \"arguments\": \"effectful\", \"callback_materialized_before_effect\": true}"),
 list(label="ordered supplied default string protected",code="local({ f <- function(x,y=x) base::do.call(\"identity\",list({x <- rai_fx_r49_ref;y})); a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,axes="{\"target_kind\": \"string\", \"arguments\": \"effectful\", \"caller_default_dependency\": true}"),
 list(label="ordered supplied default string fresh",code="local({ f <- function(x,y=x) base::do.call(\"identity\",list({x <- data.frame(value=2L);y})); a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,axes="{\"target_kind\": \"string\", \"arguments\": \"effectful\", \"caller_default_dependency\": true}"),
 list(label="ordered supplied default function protected",code="local({ f <- function(x,y=x) base::do.call(base::identity,list({x <- rai_fx_r49_ref;y})); a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,axes="{\"target_kind\": \"function\", \"arguments\": \"effectful\", \"caller_default_dependency\": true}"),
 list(label="ordered supplied default function fresh",code="local({ f <- function(x,y=x) base::do.call(base::identity,list({x <- data.frame(value=2L);y})); a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,axes="{\"target_kind\": \"function\", \"arguments\": \"effectful\", \"caller_default_dependency\": true}"),
 list(label="unknown materialized return stays unknown",code="local({ a <- do.call(\"identity\",list(unknown_result())); a$value <- 99L })",expected=FALSE,axes="{\"arguments\": \"unknown\"}"),
 list(label="computed what effects unavailable",code="local({ a <- do.call({z <- 2L;identity},list(data.frame(value=1L))); a$value <- 99L })",expected=FALSE,axes="{\"target_kind\": \"computed\"}"),
 list(label="opaque callable projection unavailable",code="local({ a <- do.call(rai_fx_r49_box[[1L]],list(data.frame(value=1L))); a$value <- 99L })",expected=FALSE,axes="{\"target_kind\": \"container_projection\"}"),
 list(label="pure forwarded literal function",code="local({ a <- do.call(function(x)x,list(data.frame(value=1L))); a$value <- 3L })",expected=TRUE,axes="{\"target_kind\": \"literal_function\", \"arguments\": \"pure\"}"),
 list(label="effectful forwarded literal function",code="local({ a <- do.call(function(x)x,list({z <- 2L;data.frame(value=1L)})); a$value <- 3L })",expected=TRUE,axes="{\"target_kind\": \"literal_function\", \"arguments\": \"effectful\"}"))
 for(item in cases) {
  result <- aut_get(".rs.rai.dataGuard")(parse(text=item$code)[[1L]],snapshot)
  item$actual <- result$ok;item$reason <- result$reason;item$mutation_executed <- FALSE
  cat("RAI_R49_FORWARDING_CASE ",jsonlite::toJSON(item,auto_unbox=TRUE),"\n",sep="")
  expect_identical(result$ok,item$expected,info=item$label)
  expect_false(grepl("could not classify",if(is.null(result$reason))"" else result$reason,fixed=TRUE),info=item$label)
 }
 cat("RAI_R49_PROTECTED_COUNTER ",jsonlite::toJSON(list(value=ref$value,mutation_executed=FALSE),auto_unbox=TRUE),"\n",sep="")
 expect_identical(ref$value,2L)
})

test_that("R50 nested callback consumption preserves data result and callable lineage", {
 fx <- aut_fixture();ref <- new.env(parent=emptyenv());ref$value <- 2L
 assign("rai_fx_r50_ref",ref,globalenv())
 assign("rai_fx_r50_fn",function(x)ref,globalenv())
 assign("rai_fx_r50_fn_box",list(function(x)ref),globalenv())
 assign("rai_fx_r50_producer",function(x)function(y)ref,globalenv())
 snapshot <- aut_snapshot_with_identity()
 cases <- list(
 list(label="nested readonly unqualified",code="lapply(list(rai_fx_r50_ref),identity)[[1L]]",expected=TRUE,kind="readonly-positive"),
 list(label="returned original mutation unqualified",code="local({ a <- lapply(list(rai_fx_r50_ref),identity)[[1L]]; a$value <- 99L })",expected=FALSE,kind="original-lineage"),
 list(label="function input returned identity unqualified",code="lapply(list(rai_fx_r50_fn),identity)[[1L]]",expected=FALSE,kind="callable-data"),
 list(label="callback literal returns callable unqualified",code="lapply(list(rai_fx_r50_ref),function(x)function(y)y)",expected=FALSE,kind="callable-result"),
 list(label="unknown callback unqualified",code="lapply(list(rai_fx_r50_ref),unknown_callback)",expected=FALSE,kind="unknown-role"),
 list(label="nested readonly qualified",code="base::lapply(list(rai_fx_r50_ref),base::identity)[[1L]]",expected=TRUE,kind="readonly-positive"),
 list(label="returned original mutation qualified",code="local({ a <- base::lapply(list(rai_fx_r50_ref),base::identity)[[1L]]; a$value <- 99L })",expected=FALSE,kind="original-lineage"),
 list(label="function input returned identity qualified",code="base::lapply(list(rai_fx_r50_fn),base::identity)[[1L]]",expected=FALSE,kind="callable-data"),
 list(label="callback literal returns callable qualified",code="base::lapply(list(rai_fx_r50_ref),function(x)function(y)y)",expected=FALSE,kind="callable-result"),
 list(label="unknown callback qualified",code="base::lapply(list(rai_fx_r50_ref),unknown_callback)",expected=FALSE,kind="unknown-role"),
 list(label="opaque function box returned cannot invoke",code="local({ f <- lapply(rai_fx_r50_fn_box,identity)[[1L]]; f(rai_fx_r50_ref) })",expected=FALSE,kind="unknown-callable-result"),
 list(label="returned function used as callback",code="lapply(list(rai_fx_r50_ref),lapply(rai_fx_r50_fn_box,identity)[[1L]])",expected=FALSE,kind="unknown-callable-result"),
 list(label="literal function passed through identity",code="local({ f <- identity(function(x)rai_fx_r50_ref); a <- f(1L); a$value <- 99L })",expected=FALSE,kind="callable-data"),
 list(label="known callback producer returns callable",code="lapply(list(rai_fx_r50_ref),rai_fx_r50_producer)",expected=FALSE,kind="callable-result"),
 list(label="callback selector producer returns callable",code="lapply(list(rai_fx_r50_ref),\"rai_fx_r50_producer\")",expected=FALSE,kind="unknown-role"),
 list(label="data field named FUN not consumed",code="list(FUN=rai_fx_r50_fn)",expected=FALSE,kind="data-role"),
 list(label="readonly nested result stays unknown",code="local({ a <- matrix(lapply(list(rai_fx_r50_ref),identity)); a$value <- 99L })",expected=FALSE,kind="unknown-result-lineage"),
 list(label="forwarded nested readonly string",code="base::do.call(\"lapply\",list(X=list(rai_fx_r50_ref),FUN=base::identity))[[1L]]",expected=TRUE,kind="forwarded-positive"),
 list(label="forwarded original mutation string",code="local({ a <- base::do.call(\"lapply\",list(X=list(rai_fx_r50_ref),FUN=base::identity))[[1L]]; a$value <- 99L })",expected=FALSE,kind="forwarded-original"),
 list(label="forwarded function data string",code="base::do.call(\"lapply\",list(X=list(rai_fx_r50_fn),FUN=base::identity))[[1L]]",expected=FALSE,kind="forwarded-callable-data"),
 list(label="forwarded unknown callback string",code="base::do.call(\"lapply\",list(X=list(rai_fx_r50_ref),FUN=\"unknown_callback\"))[[1L]]",expected=FALSE,kind="forwarded-unknown-role"),
 list(label="forwarded nested readonly function",code="base::do.call(base::lapply,list(X=list(rai_fx_r50_ref),FUN=base::identity))[[1L]]",expected=TRUE,kind="forwarded-positive"),
 list(label="forwarded original mutation function",code="local({ a <- base::do.call(base::lapply,list(X=list(rai_fx_r50_ref),FUN=base::identity))[[1L]]; a$value <- 99L })",expected=FALSE,kind="forwarded-original"),
 list(label="forwarded function data function",code="base::do.call(base::lapply,list(X=list(rai_fx_r50_fn),FUN=base::identity))[[1L]]",expected=FALSE,kind="forwarded-callable-data"),
 list(label="forwarded unknown callback function",code="base::do.call(base::lapply,list(X=list(rai_fx_r50_ref),FUN=\"unknown_callback\"))[[1L]]",expected=FALSE,kind="forwarded-unknown-role"),
 list(label="forwarded identity wraps nested readonly",code="base::do.call(\"identity\",list(lapply(list(rai_fx_r50_ref),identity)[[1L]]))",expected=TRUE,kind="forwarded-positive"),
 list(label="captured target nested readonly",code="local({ k <- base::lapply; do.call(k,list(list(rai_fx_r50_ref),base::identity))[[1L]] })",expected=TRUE,kind="captured-target"),
 list(label="captured callback before rebinding nested readonly",code="local({ identity <- base::identity; do.call(\"lapply\",list(FUN=identity,X={identity <- rai_fx_r50_fn_box[[1L]];list(rai_fx_r50_ref)}))[[1L]] })",expected=TRUE,kind="captured-callback"),
 list(label="string callback after rebinding must refuse",code="local({ do.call(\"lapply\",list(FUN=\"identity\",X={identity <- rai_fx_r50_fn_box[[1L]];list(rai_fx_r50_ref)}))[[1L]] })",expected=FALSE,kind="late-callback"),
 list(label="captured target opaque returned function refuses",code="local({ k <- base::lapply; f <- do.call(k,list(rai_fx_r50_fn_box,base::identity))[[1L]]; f(rai_fx_r50_ref) })",expected=FALSE,kind="captured-callable-data"))
 for(item in cases) {
  result <- aut_get(".rs.rai.dataGuard")(parse(text=item$code)[[1L]],snapshot)
  item$actual <- result$ok;item$reason <- result$reason;item$mutation_executed <- FALSE
  cat("RAI_R50_RESULT_FLOW_CASE ",jsonlite::toJSON(item,auto_unbox=TRUE),"\n",sep="")
  expect_identical(result$ok,item$expected,info=item$label)
  expect_false(grepl("could not classify",if(is.null(result$reason))"" else result$reason,fixed=TRUE),info=item$label)
 }
 cat("RAI_R50_PROTECTED_COUNTER ",jsonlite::toJSON(list(value=ref$value,mutation_executed=FALSE),auto_unbox=TRUE),"\n",sep="")
 expect_identical(ref$value,2L)
})

test_that("R52 forwarded caller effects preserve removal default refresh and helper isolation", {
 fx <- aut_fixture();protected <- new.env(parent=emptyenv());protected$value <- 2L
 expect_false(exists("ref",envir=globalenv(),inherits=FALSE))
 withr::defer(rm(list=intersect("ref",ls(globalenv(),all.names=TRUE)),envir=globalenv()),envir=environment())
 assign("ref",protected,globalenv());snapshot <- aut_snapshot_with_identity()
 cases <- list(
list(label="direct rm pending fallback",code="local({ f <- function(ref,y=ref) { rm(ref); y }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="pending-fallback"),
list(label="direct rm fresh return",code="local({ f <- function(ref,y=ref) { rm(ref); data.frame(value=1L) }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="fresh-return"),
list(label="direct rm pending chain",code="local({ f <- function(ref,y=ref,z=y) { rm(ref); z }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="pending-chain"),
list(label="direct rm no-op pending default",code="local({ f <- function(ref,y=ref) { rm(); y }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="no-op"),
list(label="direct rm unrelated removal",code="local({ f <- function(ref,y=ref) { tmp <- 1L; rm(tmp); y }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="unrelated-removal"),
list(label="direct rm supplied default independent",code="local({ f <- function(ref,y=ref) { rm(ref); y }; a <- f(data.frame(value=1L),data.frame(value=2L)); a$value <- 3L })",expected=TRUE,kind="supplied-default"),
list(label="direct rm captured pending default",code="local({ f <- function(ref,y=ref) { g <- function() y; rm(ref); g() }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="frame-refresh"),
list(label="direct rm rebound default independent",code="local({ f <- function(ref,y=ref) { y <- data.frame(value=2L); rm(ref); y }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="rebound-default"),
list(label="forwarded rm pending fallback",code="local({ f <- function(ref,y=ref) { base::do.call(\"rm\",list(\"ref\")); y }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="pending-fallback"),
list(label="forwarded rm fresh return",code="local({ f <- function(ref,y=ref) { base::do.call(\"rm\",list(\"ref\")); data.frame(value=1L) }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="fresh-return"),
list(label="forwarded rm pending chain",code="local({ f <- function(ref,y=ref,z=y) { base::do.call(\"rm\",list(\"ref\")); z }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="pending-chain"),
list(label="forwarded rm no-op pending default",code="local({ f <- function(ref,y=ref) { base::do.call(\"rm\",list()); y }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="no-op"),
list(label="forwarded rm unrelated removal",code="local({ f <- function(ref,y=ref) { tmp <- 1L; base::do.call(\"rm\",list(\"tmp\")); y }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="unrelated-removal"),
list(label="forwarded rm supplied default independent",code="local({ f <- function(ref,y=ref) { base::do.call(\"rm\",list(\"ref\")); y }; a <- f(data.frame(value=1L),data.frame(value=2L)); a$value <- 3L })",expected=TRUE,kind="supplied-default"),
list(label="forwarded rm captured pending default",code="local({ f <- function(ref,y=ref) { g <- function() y; base::do.call(\"rm\",list(\"ref\")); g() }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="frame-refresh"),
list(label="forwarded rm rebound default independent",code="local({ f <- function(ref,y=ref) { y <- data.frame(value=2L); base::do.call(\"rm\",list(\"ref\")); y }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="rebound-default"),
list(label="direct remove pending fallback",code="local({ f <- function(ref,y=ref) { remove(ref); y }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="pending-fallback"),
list(label="direct remove fresh return",code="local({ f <- function(ref,y=ref) { remove(ref); data.frame(value=1L) }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="fresh-return"),
list(label="direct remove pending chain",code="local({ f <- function(ref,y=ref,z=y) { remove(ref); z }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="pending-chain"),
list(label="direct remove no-op pending default",code="local({ f <- function(ref,y=ref) { remove(); y }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="no-op"),
list(label="direct remove unrelated removal",code="local({ f <- function(ref,y=ref) { tmp <- 1L; remove(tmp); y }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="unrelated-removal"),
list(label="direct remove supplied default independent",code="local({ f <- function(ref,y=ref) { remove(ref); y }; a <- f(data.frame(value=1L),data.frame(value=2L)); a$value <- 3L })",expected=TRUE,kind="supplied-default"),
list(label="direct remove captured pending default",code="local({ f <- function(ref,y=ref) { g <- function() y; remove(ref); g() }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="frame-refresh"),
list(label="direct remove rebound default independent",code="local({ f <- function(ref,y=ref) { y <- data.frame(value=2L); remove(ref); y }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="rebound-default"),
list(label="forwarded remove pending fallback",code="local({ f <- function(ref,y=ref) { base::do.call(\"remove\",list(\"ref\")); y }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="pending-fallback"),
list(label="forwarded remove fresh return",code="local({ f <- function(ref,y=ref) { base::do.call(\"remove\",list(\"ref\")); data.frame(value=1L) }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="fresh-return"),
list(label="forwarded remove pending chain",code="local({ f <- function(ref,y=ref,z=y) { base::do.call(\"remove\",list(\"ref\")); z }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="pending-chain"),
list(label="forwarded remove no-op pending default",code="local({ f <- function(ref,y=ref) { base::do.call(\"remove\",list()); y }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="no-op"),
list(label="forwarded remove unrelated removal",code="local({ f <- function(ref,y=ref) { tmp <- 1L; base::do.call(\"remove\",list(\"tmp\")); y }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="unrelated-removal"),
list(label="forwarded remove supplied default independent",code="local({ f <- function(ref,y=ref) { base::do.call(\"remove\",list(\"ref\")); y }; a <- f(data.frame(value=1L),data.frame(value=2L)); a$value <- 3L })",expected=TRUE,kind="supplied-default"),
list(label="forwarded remove captured pending default",code="local({ f <- function(ref,y=ref) { g <- function() y; base::do.call(\"remove\",list(\"ref\")); g() }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="frame-refresh"),
list(label="forwarded remove rebound default independent",code="local({ f <- function(ref,y=ref) { y <- data.frame(value=2L); base::do.call(\"remove\",list(\"ref\")); y }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="rebound-default"),
list(label="direct argument rebind protected",code="local({ f <- function(x,y=x) { identity({ x <- ref; 0L }); y }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="argument-rebinding"),
list(label="direct argument rebind fresh",code="local({ f <- function(x,y=x) { identity({ x <- data.frame(value=2L); 0L }); y }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="argument-rebinding"),
list(label="forwarded argument rebind protected",code="local({ f <- function(x,y=x) { base::do.call(\"identity\",list({ x <- ref; 0L })); y }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="argument-rebinding"),
list(label="forwarded argument rebind fresh",code="local({ f <- function(x,y=x) { base::do.call(\"identity\",list({ x <- data.frame(value=2L); 0L })); y }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="argument-rebinding"),
list(label="global forwarding overlay cannot hide later original rebind",code="{ a <- data.frame(value=1L); base::do.call(\"identity\",list({a <- data.frame(value=2L);0L})); a <- ref; a$value <- 99L }",expected=FALSE,kind="global-isolation"),
list(label="global readonly new data remains mutable",code="{ a <- base::do.call(\"identity\",list(data.frame(value=1L))); a$value <- 3L }",expected=TRUE,kind="new-data"),
list(label="local readonly pending default retains freshness",code="local({ f <- function(ref,y=ref) { base::do.call(\"identity\",list(1L)); y }; a <- f(data.frame(value=1L)); a$value <- 3L })",expected=TRUE,kind="readonly-default"),
list(label="forwarded helper rm stays isolated",code="local({ ref <- data.frame(value=1L); f <- function(ref) { rm(ref); data.frame(value=2L) }; base::do.call(f,list(1L)); ref$value <- 3L })",expected=TRUE,kind="helper-isolation"),
list(label="forwarded named rm pending fallback",code="local({ f <- function(ref,y=ref) { base::do.call(\"rm\",list(list=\"ref\")); y }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="named-removal"),
list(label="captured canonical rm pending fallback",code="local({ f <- function(ref,y=ref) { k <- base::rm; do.call(k,list(\"ref\")); y }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="captured-removal"),
list(label="forwarded helper remove stays isolated",code="local({ ref <- data.frame(value=1L); f <- function(ref) { remove(ref); data.frame(value=2L) }; base::do.call(f,list(1L)); ref$value <- 3L })",expected=TRUE,kind="helper-isolation"),
list(label="forwarded named remove pending fallback",code="local({ f <- function(ref,y=ref) { base::do.call(\"remove\",list(list=\"ref\")); y }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="named-removal"),
list(label="captured canonical remove pending fallback",code="local({ f <- function(ref,y=ref) { k <- base::remove; do.call(k,list(\"ref\")); y }; a <- f(data.frame(value=1L)); a$value <- 99L })",expected=FALSE,kind="captured-removal"),
list(label="forwarded helper rebinding stays isolated",code="local({ ref <- data.frame(value=1L); f <- function(x) { x <- ref; data.frame(value=2L) }; base::do.call(f,list(1L)); ref$value <- 3L })",expected=TRUE,kind="helper-isolation"))
 for(item in cases) {
  result <- aut_get(".rs.rai.dataGuard")(parse(text=item$code)[[1L]],snapshot)
  item$actual <- result$ok;item$reason <- result$reason;item$mutation_executed <- FALSE
  cat("RAI_R52_CALLER_EFFECT_CASE ",jsonlite::toJSON(item,auto_unbox=TRUE),"\n",sep="")
  expect_identical(result$ok,item$expected,info=item$label)
 }
 expect_identical(protected$value,2L);expect_length(fx$events$items,0L)
 cat("RAI_R52_PROTECTED_COUNTER ",jsonlite::toJSON(list(value=protected$value,mutation_executed=FALSE),auto_unbox=TRUE),"\n",sep="")
 rm(list=intersect("ref",ls(globalenv(),all.names=TRUE)),envir=globalenv())
})
