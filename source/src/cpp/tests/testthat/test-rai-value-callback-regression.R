# Covered literal/canonical callbacks preserve positive numeric planning, not
# arbitrary executable callbacks, hidden dispatch, or protected-data writes.
test_that("bounded value callbacks preserve numeric planning and callable/data boundaries", {
   fx <- aut_fixture(identity = FALSE)
   guard <- aut_get(".rs.rai.dataGuard")
   check <- function(code) guard(parse(text=code)[[1L]], aut_get(".rs.rai.globalSnapshot")())
   expect_true(check("{ rai_fx_values <- 1:5; rai_fx_squares <- sapply(rai_fx_values, function(x) x^2); sum(rai_fx_squares) }")$ok)
   expect_true(check("{ rai_fx_df <- data.frame(g=c('x','x','y'),v=c(42,264,10)); rai_fx_a <- aggregate(v~g,data=rai_fx_df,FUN=sum); sum(rai_fx_a$v) }")$ok)
   orig <- new.env(parent=emptyenv()); orig$value <- 2L
   assign("rai_fx_callback_orig", orig, globalenv())
   before <- orig$value
   negatives <- c(
      "lapply(1:2,function(x) { rai_fx_callback_orig$value <- 99L; x })",
      "lapply(1:2,function(x) function() rai_fx_callback_orig)",
      "lapply(1:2,function(x= { rai_fx_callback_orig$value <- 99L; 1L }) x^2)",
      "lapply(1:2,function(x) get('rai_fx_callback_orig'))")
   for (code in negatives) expect_false(check(code)$ok)
   expect_identical(orig$value, before) # negative expressions never evaluated
   # Unrelated methods cannot dispatch on inspected plain numeric callback inputs.
   assign("Summary.rai_fx_uninspected", function(...) { orig$value <- 99L; 0 }, globalenv())
   expect_true(check("aggregate(1:2,by=list(1:2),FUN=sum)")$ok)
   expect_true(check("{ rai_fx_df <- data.frame(g=c('x','x'),v=c(1,2)); aggregate(v~g,data=rai_fx_df,FUN=sum) }")$ok)
   assign("rai_fx_callback_classed", structure(1:2,class="rai_fx_uninspected"), globalenv())
   expect_false(check("aggregate(rai_fx_callback_classed,by=list(1:2),FUN=sum)")$ok)
   expect_identical(orig$value, before)
   rm("Summary.rai_fx_uninspected", envir=globalenv())
   assign("Ops.rai_fx_uninspected", function(...) { orig$value <- 99L; 0 }, globalenv())
   expect_true(check("sapply(1:2,function(x)x)")$ok) # symbol-only: NO Ops operation
   expect_true(check("sapply(1:2,function(x)x^2)")$ok)
   expect_true(check("{ rai_fx_values <- 1:2; sapply(rai_fx_values,function(x)x^2) }")$ok)
   expect_true(check("sapply(list(1,2),function(x)x^2)")$ok)
   assign("rai_fx_callback_numeric", 1:2, globalenv())
      diagnostic <- check("sapply(rai_fx_callback_numeric,function(x)x^2)")
   if (!isTRUE(diagnostic$ok)) {
      s <- aut_get(".rs.rai.globalSnapshot")(); native <- .Call("rs_raiGlobalBindingSnapshot",PACKAGE="(embedding)")
      cat("P2_NUMERIC_INPUT_FAILURE ",jsonlite::toJSON(list(result=diagnostic,
         snapshot_id=s$identities[match("rai_fx_callback_numeric",s$names)],
         native_id=native$identities[match("rai_fx_callback_numeric",native$names)],
         typeof=typeof(get("rai_fx_callback_numeric",globalenv())),class=attr(get("rai_fx_callback_numeric",globalenv()),"class",exact=TRUE),
         snapshot_body=paste(deparse(body(aut_get(".rs.rai.globalSnapshot"))),collapse=" ")),auto_unbox=TRUE),"\n",sep="")
   }
   expect_true(diagnostic$ok)
   expect_false(check("sapply(rai_fx_callback_classed,function(x)x^2)")$ok)
   expect_false(check("sapply(unknown_callback_input,function(x)x^2)")$ok)
   expect_false(check("{ rai_fx_classed <- structure(1:2,class='rai_fx_uninspected'); sapply(rai_fx_classed,function(x)x^2) }")$ok)
   expect_identical(orig$value, before) # methods/negative expressions never executed
   rm("Ops.rai_fx_uninspected", envir=globalenv())
})

test_that("callback dispatch witnesses never force active or delayed inputs", {
   fx <- aut_fixture(identity = FALSE)
   guard <- aut_get(".rs.rai.dataGuard")
   state <- new.env(parent=emptyenv()); state$active <- 0L; state$promise <- 0L; state$method <- 0L
   makeActiveBinding("rai_fx_callback_active", function() { state$active <- state$active+1L; 1:2 }, globalenv())
   delayedAssign("rai_fx_callback_delayed", { state$promise <- state$promise+1L; 1:2 }, assign.env=globalenv())
   assign("Ops.rai_fx_unknown", function(...) { state$method <- state$method+1L; 0 }, globalenv())
   assign("Summary.rai_fx_unknown", function(...) { state$method <- state$method+1L; 0 }, globalenv())
   for (name in c("rai_fx_callback_active", "rai_fx_callback_delayed")) {
      snapshot <- aut_get(".rs.rai.globalSnapshot")()
      expect_false(guard(parse(text=sprintf("sapply(%s,function(x)x^2)",name))[[1L]],snapshot)$ok)
      expect_false(guard(parse(text=sprintf("aggregate(%s,by=list(1:2),FUN=sum)",name))[[1L]],snapshot)$ok)
   }
   expect_identical(state$active,0L); expect_identical(state$promise,0L); expect_identical(state$method,0L)
   rm("rai_fx_callback_active","rai_fx_callback_delayed","Ops.rai_fx_unknown","Summary.rai_fx_unknown",envir=globalenv())
})


test_that("class-producing I invalidates dispatch witnesses without forcing or losing positives", {
   fx <- aut_fixture(identity = FALSE)
   guard <- aut_get(".rs.rai.dataGuard")
   check <- function(code) guard(parse(text=code)[[1L]], aut_get(".rs.rai.globalSnapshot")())
   state <- new.env(parent=emptyenv())
   state$protected <- 2L; state$method <- 0L; state$active <- 0L; state$promise <- 0L
   method <- function(...) { state$method <- state$method+1L; state$protected <- 99L; 0 }
   methods <- c("Summary.AsIs", "Ops.AsIs", "Summary.rai_fx_P1_unrelated", "Ops.rai_fx_P1_unrelated")
   saved <- lapply(methods, function(name) if (exists(name,globalenv(),inherits=FALSE)) get(name,globalenv()) else NULL)
   withr::defer(for (i in seq_along(methods)) {
      if (is.null(saved[[i]])) { if (exists(methods[[i]],globalenv(),inherits=FALSE)) rm(list=methods[[i]],envir=globalenv()) }
      else assign(methods[[i]],saved[[i]],globalenv())
   })
   for (name in methods) assign(name,method,globalenv())
   assign("rai_fx_P1_numeric",1:2,globalenv())
   makeActiveBinding("rai_fx_P1_active",function() { state$active <- state$active+1L; 1:2 },globalenv())
   delayedAssign("rai_fx_P1_delayed",{ state$promise <- state$promise+1L; 1:2 },assign.env=globalenv())
   negatives <- c(
      "aggregate(I(1:2),by=list(1:2),FUN=sum)",
      "aggregate(base::I(1:2),by=list(1:2),FUN=sum)",
      "aggregate(I(rai_fx_P1_numeric),by=list(1:2),FUN=sum)",
      "{ rai_fx_P1_x <- I(1:2); aggregate(rai_fx_P1_x,by=list(1:2),FUN=sum) }",
      "{ rai_fx_P1_f <- function(x) I(x); aggregate(rai_fx_P1_f(1:2),by=list(1:2),FUN=sum) }",
      "{ rai_fx_P1_df <- data.frame(g=c(1,2),v=I(1:2)); aggregate(v~g,data=rai_fx_P1_df,FUN=sum) }",
      "{ rai_fx_P1_df <- I(data.frame(g=c(1,2),v=c(1,2))); aggregate(v~g,data=rai_fx_P1_df,FUN=sum) }",
      "sapply(I(1:2),function(x)x^2)",
      "sapply(I(list(1,2)),function(x)x^2)",
      "sapply(list(I(1),I(2)),function(x)x^2)",
      "sapply(structure(1:2,class='AsIs'),function(x)x^2)",
      "{ rai_fx_P1_x <- 1:2; class(rai_fx_P1_x) <- 'AsIs'; aggregate(rai_fx_P1_x,by=list(1:2),FUN=sum) }",
      "aggregate(I(rai_fx_P1_active),by=list(1:2),FUN=sum)",
      "aggregate(I(rai_fx_P1_delayed),by=list(1:2),FUN=sum)",
      "aggregate(I(rai_fx_P1_unknown),by=list(1:2),FUN=sum)")
   # Policy only: neither proposals nor hidden methods/defaults/getters run.
   for (code in negatives) expect_false(check(code)$ok,info=code)
   positives <- c("I(1:2)", "sapply(I(1:2),identity)",
      "aggregate(1:2,by=list(1:2),FUN=sum)",
      "aggregate((1:2),by=list(1:2),FUN=sum)",
      "aggregate(identity(1:2),by=list(1:2),FUN=sum)",
      "sapply(list(1,2),function(x)x^2)",
      "sapply(rai_fx_P1_numeric,function(x)x^2)",
      "{ rai_fx_P1_df <- data.frame(g=c(1,2),v=c(1,2)); aggregate(v~g,data=rai_fx_P1_df,FUN=sum) }")
   for (code in positives) expect_true(check(code)$ok,info=code)
   expect_identical(state$protected,2L); expect_identical(state$method,0L)
   expect_identical(state$active,0L); expect_identical(state$promise,0L)
})


test_that("extracted containers cannot inherit a parent's numeric column schema", {
   fx <- aut_fixture(identity=FALSE); guard <- aut_get(".rs.rai.dataGuard")
   check <- function(code) guard(parse(text=code)[[1L]],aut_get(".rs.rai.globalSnapshot")())
   state <- new.env(parent=emptyenv()); state$protected <- 2L; state$method <- 0L
   nested <- structure(list(x=structure(1:2,class="AsIs"),g=1:2),class="data.frame",row.names=1:2)
   assign("rai_fx_P1_outer",structure(list(x=1:2,payload=nested),class="data.frame",row.names=1:2),globalenv())
   previous <- if(exists("Summary.AsIs",globalenv(),inherits=FALSE)) get("Summary.AsIs",globalenv()) else NULL
   withr::defer(if(is.null(previous)) rm("Summary.AsIs",envir=globalenv()) else assign("Summary.AsIs",previous,globalenv()))
   assign("Summary.AsIs",function(...) {state$method<-state$method+1L;state$protected<-99L;0},globalenv())
   for(input in c("rai_fx_P1_outer$payload","rai_fx_P1_outer[['payload']]","rai_fx_P1_outer[,'payload']"))
      expect_false(check(paste0("aggregate(x~g,data=",input,",FUN=sum)"))$ok,info=input)
   # Scalar/element numeric witnesses remain valid through ordinary extraction.
   for(code in c("sapply((1:2)[1L],function(x)x^2)","sapply((1:2)[[1L]],function(x)x^2)",
      "sapply(list(1,2)[[1L]],function(x)x^2)","aggregate(1:2,by=list(1:2),FUN=sum)"))
      expect_true(check(code)$ok,info=code)
   expect_identical(state$method,0L);expect_identical(state$protected,2L)
})


test_that("final column identity and ordinary row-only schemas stay bounded and nonforcing", {
   fx <- aut_fixture(identity=FALSE); guard <- aut_get(".rs.rai.dataGuard")
   check <- function(code) guard(parse(text=code)[[1L]],aut_get(".rs.rai.globalSnapshot")())
   state <- new.env(parent=emptyenv());state$protected<-2L;state$method<-0L;state$active<-0L;state$promise<-0L
   method <- function(...) {state$method<-state$method+1L;state$protected<-99L;0}
   methods <- c("Summary.AsIs","Summary.rai_fx_names_unknown","Summary.rai_fx_names_unrelated")
   previous <- lapply(methods,function(n)if(exists(n,globalenv(),inherits=FALSE))get(n,globalenv())else NULL)
   withr::defer(for(i in seq_along(methods)){
      if(is.null(previous[[i]])){if(exists(methods[[i]],globalenv(),inherits=FALSE))rm(list=methods[[i]],envir=globalenv())}
      else assign(methods[[i]],previous[[i]],globalenv())
   })
   for(n in methods) assign(n,method,globalenv())
   assign("rai_fx_names_real_duplicate",structure(list(g=1:2,v=structure(1:2,class="AsIs"),v=1:2),class="data.frame",row.names=1:2),globalenv())
   assign("rai_fx_names_real_plain",data.frame(g=1:2,v=1:2),globalenv())
   assign("rai_fx_names_real_matrix",matrix(1:4,ncol=2),globalenv())
   assign("rai_fx_names_real_unknown",structure(list(g=1:2,v=1:2),class=c("rai_fx_names_unknown","data.frame"),row.names=1:2),globalenv())
   assign("rai_fx_names_index",1:2,globalenv())
   makeActiveBinding("rai_fx_names_active",function(){state$active<-state$active+1L;1:2},globalenv())
   delayedAssign("rai_fx_names_delayed",{state$promise<-state$promise+1L;1:2},assign.env=globalenv())
   negatives <- c(
      "{ rai_fx_df<-data.frame(g=1:2,v=I(1:2),v=1:2);aggregate(v~g,data=rai_fx_df,FUN=sum) }",
      "{ rai_fx_df<-data.frame(g=1:2,v=I(1:2),v=1:2,check.names=FALSE);aggregate(v~g,data=rai_fx_df,FUN=sum) }",
      "{ rai_fx_df<-data.frame(g=1:2,v=1:2,v=I(1:2));aggregate(v~g,data=rai_fx_df,FUN=sum) }",
      "{ rai_fx_df<-data.frame(g=1:2,`v v`=I(1:2),v.v=1:2);aggregate(v.v~g,data=rai_fx_df,FUN=sum) }",
      "{ rai_fx_df<-data.frame(g=1:2,`v v`=I(1:2),`v v`=1:2,check.names=FALSE);aggregate(`v v`~g,data=rai_fx_df,FUN=sum) }",
      "{ rai_fx_df<-data.frame(g=1:2,v=1:2,v=1:2);aggregate(v~g,data=rai_fx_df[1:2,,drop=FALSE],FUN=sum) }",
      "{ rai_fx_df<-data.frame(g=1:2,v=1:2,check.names=rai_fx_names_active);aggregate(v~g,data=rai_fx_df,FUN=sum) }",
      "{ rai_fx_df<-data.frame(g=1:2,v=rai_fx_names_real_matrix);aggregate(v~g,data=rai_fx_df,FUN=sum) }",
      "aggregate(v~g,data=rai_fx_names_real_duplicate,FUN=sum)",
      "aggregate(v~g,data=rai_fx_names_real_unknown[1:2,,drop=FALSE],FUN=sum)",
      "aggregate(v~g,data=I(rai_fx_names_real_plain)[1:2,,drop=FALSE],FUN=sum)",
      "aggregate(v~g,data=rai_fx_names_real_plain[,c('g','v'),drop=FALSE],FUN=sum)",
      "aggregate(v~g,data=rai_fx_names_real_plain[1:2,],FUN=sum)",
      "aggregate(v~g,data=rai_fx_names_real_plain[1:2],FUN=sum)",
      "aggregate(v~g,data=rai_fx_names_real_plain[rai_fx_names_active,,drop=FALSE],FUN=sum)",
      "aggregate(v~g,data=rai_fx_names_real_plain[rai_fx_names_delayed,,drop=FALSE],FUN=sum)",
      "aggregate(v~g,data=rai_fx_names_real_plain[{state$protected<-99L;1:2},,drop=FALSE],FUN=sum)")
   for(code in negatives) expect_false(check(code)$ok,info=code)
   positives <- c(
      "{ rai_fx_df<-data.frame(g=1:2,v=1:2);aggregate(v~g,data=rai_fx_df,FUN=sum) }",
      "{ rai_fx_df<-data.frame(g=c('a','b'),v=c(1,2));aggregate(v~g,data=rai_fx_df[1:2,,drop=FALSE],FUN=sum) }",
      "{ rai_fx_df<-data.frame(g=1:2,v=1:2);aggregate(v~g,data=rai_fx_df[1:2,,drop=FALSE],FUN=sum) }",
      "{ rai_fx_df<-data.frame(g=1:2,v=1:2,check.names=FALSE);aggregate(v~g,data=rai_fx_df[1:2,,drop=FALSE],FUN=sum) }",
      "{ rai_fx_df<-data.frame(g=1:2,`v v`=1:2,check.names=FALSE);aggregate(`v v`~g,data=rai_fx_df,FUN=sum) }",
      "{ rai_fx_df<-data.frame(g=1:2,v=1:2,fix.empty.names=FALSE);aggregate(v~g,data=rai_fx_df,FUN=sum) }",
      "{ rai_fx_f<-function(x)x[1:2,,drop=FALSE];aggregate(v~g,data=rai_fx_f(data.frame(g=1:2,v=1:2)),FUN=sum) }",
      "aggregate(v~g,data=rai_fx_names_real_plain[c(1L,2L),,drop=FALSE],FUN=sum)",
      "aggregate(v~g,data=rai_fx_names_real_plain[TRUE,,drop=FALSE],FUN=sum)",
      "aggregate(v~g,data=rai_fx_names_real_plain[-1L,,drop=FALSE],FUN=sum)",
      "aggregate(v~g,data=rai_fx_names_real_plain[rai_fx_names_index,,drop=FALSE],FUN=sum)",
      "aggregate(v~g,data=rai_fx_names_real_plain[,,drop=FALSE],FUN=sum)",
      "aggregate(v~g,data=rai_fx_names_real_plain[1:2,,drop=FALSE][1:2,,drop=FALSE],FUN=sum)")
   for(code in positives) expect_true(check(code)$ok,info=code)
   expect_identical(state$protected,2L);expect_identical(state$method,0L)
   # A latent generic callback definition on unproved x remains the established
   # higher-order refusal; the supported helper-return schema case stays positive.
   expect_false(check("{ rai_fx_f<-function(x){aggregate(v~g,data=x[1:2,,drop=FALSE],FUN=sum)};rai_fx_f(data.frame(g=1:2,v=1:2)) }")$ok)
   expect_identical(state$active,0L);expect_identical(state$promise,0L)
})
