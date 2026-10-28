/*
 * SessionRaiAssistantTests.cpp
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

#include <cstdlib>
#include <initializer_list>
#include <chrono>
#include <thread>
// S3C_FIXTURE_BEGIN
#ifndef R_NO_REMAP
#define R_NO_REMAP
#endif
#define ENABLE_LEGACY_NONAPI_FUNS
#include <R.h>
#include <Rinternals.h>
#include <R_ext/Altrep.h>
#include <R_ext/Rdynload.h>

namespace {
int raiS3cCounts[4] = {0, 0, 0, 0};
R_xlen_t raiS3cLength(SEXP x) { ++raiS3cCounts[0]; return XLENGTH(R_altrep_data1(x)); }
SEXP raiS3cStringElt(SEXP x, R_xlen_t i) { ++raiS3cCounts[1]; return STRING_ELT(R_altrep_data1(x), i); }
int raiS3cIntegerElt(SEXP x, R_xlen_t i) { ++raiS3cCounts[1]; return INTEGER_ELT(R_altrep_data1(x), i); }
SEXP raiS3cListElt(SEXP x, R_xlen_t i) { ++raiS3cCounts[1]; return VECTOR_ELT(R_altrep_data1(x), i); }
void* raiS3cDataptr(SEXP x, Rboolean) { ++raiS3cCounts[2]; return DATAPTR(R_altrep_data1(x)); }
const void* raiS3cDataptrOrNull(SEXP x) { ++raiS3cCounts[3]; return DATAPTR_RO(R_altrep_data1(x)); }

SEXP raiS3cDeferred(SEXP backing)
{
   static bool initialized = false;
   static R_altrep_class_t strings, integers, lists;
   if (!initialized)
   {
      strings = R_make_altstring_class("rai_s3c_string", "rai_s3c_tests", nullptr);
      integers = R_make_altinteger_class("rai_s3c_integer", "rai_s3c_tests", nullptr);
      lists = R_make_altlist_class("rai_s3c_list", "rai_s3c_tests", nullptr);
      for (auto cls : {strings, integers, lists})
      {
         R_set_altrep_Length_method(cls, raiS3cLength);
         R_set_altvec_Dataptr_method(cls, raiS3cDataptr);
         R_set_altvec_Dataptr_or_null_method(cls, raiS3cDataptrOrNull);
      }
      R_set_altstring_Elt_method(strings, raiS3cStringElt);
      R_set_altinteger_Elt_method(integers, raiS3cIntegerElt);
      R_set_altlist_Elt_method(lists, raiS3cListElt);
      initialized = true;
   }
   return R_new_altrep(TYPEOF(backing) == STRSXP ? strings :
                       TYPEOF(backing) == INTSXP ? integers : lists,
                       backing, R_NilValue);
}

// Bypass attribute setters so fixture construction cannot normalize deferred metadata
void raiS3cAttribute(SEXP x, SEXP tag, SEXP value)
{
   SEXP node = PROTECT(Rf_cons(value, ATTRIB(x)));
   SET_TAG(node, tag);
   SET_ATTRIB(x, node);
   if (tag == R_ClassSymbol) SET_OBJECT(x, 1);
   UNPROTECT(1);
}
}

extern "C" SEXP rai_s3c_reset()
{
   for (int& count : raiS3cCounts) count = 0;
   return R_NilValue;
}

extern "C" SEXP rai_s3c_counts()
{
   SEXP result = PROTECT(Rf_allocVector(INTSXP, 4));
   for (int i = 0; i < 4; ++i) INTEGER(result)[i] = raiS3cCounts[i];
   UNPROTECT(1);
   return result;
}

extern "C" SEXP rai_s3c_fixture(SEXP kindSEXP)
{
   const int kind = Rf_asInteger(kindSEXP);
   SEXP strings = PROTECT(Rf_allocVector(STRSXP, 2));
   SET_STRING_ELT(strings, 0, Rf_mkChar("a"));
   SET_STRING_ELT(strings, 1, Rf_mkChar("b"));
   SEXP dims = PROTECT(Rf_allocVector(INTSXP, 2));
   INTEGER(dims)[0] = 2; INTEGER(dims)[1] = 2;
   SEXP column = PROTECT(Rf_allocVector(INTSXP, 2));
   INTEGER(column)[0] = 1; INTEGER(column)[1] = 2;
   SEXP frame = PROTECT(Rf_allocVector(VECSXP, 2));
   SET_VECTOR_ELT(frame, 0, column); SET_VECTOR_ELT(frame, 1, column);
   SEXP cls = PROTECT(Rf_mkString("data.frame"));
   raiS3cAttribute(frame, R_ClassSymbol, cls);
   raiS3cAttribute(frame, R_NamesSymbol, strings);
   SEXP matrix = PROTECT(Rf_allocVector(INTSXP, 4));
   raiS3cAttribute(matrix, R_DimSymbol, dims);
   SEXP dimnames = PROTECT(Rf_allocVector(VECSXP, 2));
   SET_VECTOR_ELT(dimnames, 1, strings);
   SEXP deferred = R_NilValue;
   SEXP result = frame;
   if (kind == 0 || kind == 1 || kind == 4 || kind == 11)
      deferred = PROTECT(raiS3cDeferred(strings));
   else if (kind == 2 || kind == 6 || kind == 7 || kind == 8 || kind == 9)
      deferred = PROTECT(raiS3cDeferred((kind == 2 || kind == 8 || kind == 9) ? dims : column));
   else
      deferred = PROTECT(raiS3cDeferred(kind == 3 ? dimnames : frame));
   switch (kind)
   {
   case 0: raiS3cAttribute(frame, R_ClassSymbol, deferred); break;
   case 1: raiS3cAttribute(frame, R_NamesSymbol, deferred); break;
   case 2: result = matrix; raiS3cAttribute(matrix, R_DimSymbol, deferred); break;
   case 3: result = matrix; raiS3cAttribute(matrix, R_DimNamesSymbol, deferred); break;
   case 4:
      result = matrix;
      SET_VECTOR_ELT(dimnames, 1, deferred);
      raiS3cAttribute(matrix, R_DimNamesSymbol, dimnames); break;
   case 5:
      result = deferred;
      raiS3cAttribute(result, R_ClassSymbol, cls);
      raiS3cAttribute(result, R_NamesSymbol, strings); break;
   case 6: result = deferred; break;
   case 7: SET_VECTOR_ELT(frame, 0, deferred); break;
   case 8: raiS3cAttribute(frame, R_DimSymbol, deferred); break;
   case 9:
      raiS3cAttribute(frame, R_DimSymbol, deferred); break;
   case 10: result = deferred; break;
   case 11: result = deferred; break;
   default: Rf_error("Unknown S3c fixture");
   }
   UNPROTECT(8);
   return result;
}
// S3C_FIXTURE_END

#ifndef RAI_S3C_FIXTURE_ONLY
#include "SessionRaiAssistant.hpp"

#include <algorithm>
#include <limits>
#include <string>
#include <vector>

#ifndef _WIN32
#include <unistd.h>
#endif

#include <gtest/gtest.h>

#include <r/RSexp.hpp>
#include <r/RExec.hpp>

#include <shared_core/FilePath.hpp>
#include <shared_core/json/Json.hpp>
#include <core/FileSerializer.hpp>
#include <core/system/Crypto.hpp>
#include <core/http/Request.hpp>
#include <core/http/Response.hpp>

namespace rstudio { namespace session { namespace modules { namespace rai_assistant {
void raiSignCallbackForTests(core::http::Request*, const std::string&);
}}}}

using namespace rstudio::session::modules::rai_assistant;
using rstudio::core::Error;
using rstudio::core::FilePath;
using rstudio::core::http::Request;
using rstudio::core::http::Response;

namespace {
Error invokeProven(Error (*handler)(const Request&, Response*), Request& request, Response* response)
{
   const std::string token = request.headerValue("X-RAI-Bridge-Token");
   raiSignCallbackForTests(&request, token);
   Error error = handler(request, response);
   request.removeHeader("X-RAI-Peer-Nonce");
   request.removeHeader("X-RAI-Peer-Proof");
   if (!token.empty()) request.setHeader("X-RAI-Bridge-Token", token);
   return error;
}
}


#ifdef __APPLE__
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <chrono>
#include <thread>
#include <fstream>
#include <algorithm>

namespace rstudio { namespace session { namespace modules { namespace rai_assistant {
core::Error raiSpawnDetachedForTests(const std::string&, const std::string&, const std::string&, long*, const int* = nullptr, int = 1024);
void raiCloseDescriptorsForTests(int, int);
}}}}

namespace {
int c6LaunchInDisposable(bool hard, bool highFd, bool missing, const int* cap = nullptr,
                         const char* refusal = nullptr, int probeFd = 1024)
{
   const char* output = std::getenv("RAI_C6_OUTPUT_DIR");
   std::string pattern = std::string(output ? output : "/tmp") + "/rai-c6-XXXXXX";
   std::vector<char> directory(pattern.begin(), pattern.end());
   directory.push_back('\0');
   if (!::mkdtemp(directory.data())) return 10;
   const std::string dir(directory.data()), log = dir + "/output";
   struct Cleanup
   {
      std::string dir, log;
      bool retain;
      int high = -1;
      ~Cleanup()
      {
         if (high >= 0) ::close(high);
         if (!retain) { ::unlink(log.c_str()); ::rmdir(dir.c_str()); }
      }
   } cleanup{dir, log, output != nullptr};
   // Normalize only the disposable process, never the native test parent
   ::close(probeFd);
   if (highFd)
   {
      struct rlimit limits;
      if (::getrlimit(RLIMIT_NOFILE, &limits)) return 13;
      if (limits.rlim_cur <= static_cast<rlim_t>(probeFd))
      {
         limits.rlim_cur = probeFd + 1;
         if (::setrlimit(RLIMIT_NOFILE, &limits)) return 14;
      }
      int fd = ::open("/dev/null", O_RDONLY);
      if (fd < 0) return 15;
      errno = 0;
      if (::fcntl(probeFd, F_GETFD) != -1 || errno != EBADF)
      {
         ::close(fd);
         return 21;
      }
      cleanup.high = ::fcntl(fd, F_DUPFD, probeFd);
      ::close(fd);
      if (cleanup.high != probeFd) return 15;
      if (::fcntl(cleanup.high, F_GETFD) != 0) return 22;
      limits.rlim_cur = hard ? 512 : 1024;
      if (hard) limits.rlim_max = 512;
      if (::setrlimit(RLIMIT_NOFILE, &limits)) return 16;
   }
   struct rlimit setupLimits;
   if (::getrlimit(RLIMIT_NOFILE, &setupLimits)) return 13;
   errno = 0;
   int setupFlags = ::fcntl(probeFd, F_GETFD);
   int setupErrno = errno;
   std::fprintf(stderr, "C6_SETUP high=%d probe=%d soft=%llu hard=%llu probe_flags=%d/%d output=%s\n",
                highFd, probeFd, static_cast<unsigned long long>(setupLimits.rlim_cur),
                static_cast<unsigned long long>(setupLimits.rlim_max),
                setupFlags, setupErrno, log.c_str());
   long pid = -1;
   Error error = raiSpawnDetachedForTests(missing ? dir + "/missing" : "/bin/sh", dir, log, &pid, cap, probeFd);
   if (error) std::fprintf(stderr, "C6_LAUNCH_ERROR %s\n", error.asString().c_str());
   if (highFd && ::fcntl(cleanup.high, F_GETFD) != 0) return 26;
   int result = 17;
   if (refusal)
   {
      if (!error && pid > 0)
      {
         for (int i = 0; i < 500; ++i)
         {
            std::ifstream in(log);
            std::string line;
            std::getline(in, line);
            if (!line.empty()) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
         }
      }
      const bool noLog = ::access(log.c_str(), F_OK) == -1 && errno == ENOENT;
      const std::string diagnostic = error.asString();
      std::fprintf(stderr, "C6_CAP refusal=%s pid=%ld no_log=%d diagnostic=%s\n",
                   refusal, pid, noLog, diagnostic.c_str());
      result = error && error.getCode() == EINVAL && pid == -1 && noLog &&
         diagnostic.find(refusal) != std::string::npos ? 0 : 25;
   }
   else if (missing)
      result = error && error.getCode() == ENOENT && pid == -1 ? 0 : 18;
   else if (!error && pid > 0)
   {
      for (int i = 0; i < 500; ++i)
      {
         std::ifstream in(log);
         std::string line;
         std::getline(in, line);
         if (!line.empty())
         {
            std::fprintf(stderr, "C6_CHILD %s\n", line.c_str());
            result = line == "CLOSED fd0=1 fd1=1 fd2=1 fd" + std::to_string(probeFd) + "=0 extra=0" ? 0 : 19;
            break;
         }
         std::this_thread::sleep_for(std::chrono::milliseconds(10));
      }
   }
   return result;
}

int c6LaunchCheck(bool hard, bool highFd, bool missing, const int* cap = nullptr,
                  const char* refusal = nullptr, int probeFd = 1024)
{
   pid_t child = ::fork();
   if (child < 0) return 23;
   if (!child) ::_exit(c6LaunchInDisposable(hard, highFd, missing, cap, refusal, probeFd));
   int status = 0;
   pid_t waited;
   do { waited = ::waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
   return waited == child && WIFEXITED(status) ? WEXITSTATUS(status) : 24;
}

void c6Check(bool hard, bool highFd, bool missing)
{
   EXPECT_EQ(0, c6LaunchCheck(hard, highFd, missing));
}
}

TEST(SessionRaiAssistant, C6ClosesFdAboveLoweredSoftLimit) { c6Check(false, true, false); }
TEST(SessionRaiAssistant, C6ClosesFdAboveLoweredHardLimit) { c6Check(true, true, false); }
TEST(SessionRaiAssistant, C6PreservesStdio) { c6Check(false, false, false); }
TEST(SessionRaiAssistant, C6ReportsExecErrno) { c6Check(false, false, true); }

TEST(SessionRaiAssistant, C6SysctlFailure)
{
   const int cap[] = {-1, 92160, 4};
   EXPECT_EQ(0, c6LaunchCheck(false, true, false, cap, nullptr, 5000));
}

TEST(SessionRaiAssistant, C6MalformedCap)
{
   const int cap[] = {0, 92160, 1};
   EXPECT_EQ(0, c6LaunchCheck(false, true, false, cap, nullptr, 5000));
}

TEST(SessionRaiAssistant, C6ZeroCap)
{
   const int cap[] = {0, 0, 4};
   EXPECT_EQ(0, c6LaunchCheck(false, true, false, cap, nullptr, 5000));
}

TEST(SessionRaiAssistant, C6NegativeCap)
{
   const int cap[] = {0, -1, 4};
   EXPECT_EQ(0, c6LaunchCheck(false, true, false, cap, nullptr, 5000));
}

TEST(SessionRaiAssistant, C6AboveMaximumCap)
{
   const int cap[] = {0, 1048577, 4};
   EXPECT_EQ(0, c6LaunchCheck(false, true, false, cap, nullptr, 5000));
}

TEST(SessionRaiAssistant, C6MaximumCap)
{
   const int cap[] = {0, 1048576, 4};
   EXPECT_EQ(0, c6LaunchCheck(false, false, false, cap, nullptr));
}

TEST(SessionRaiAssistant, C6FallbackRlimitMatrix)
{
   for (const auto& cap : {std::vector<int>{-1, 92160, 4},
                           std::vector<int>{0, 1048577, 4},
                           std::vector<int>{0, 92160, 4}})
      for (bool hard : {false, true})
         EXPECT_EQ(0, c6LaunchCheck(hard, true, false, cap.data(), nullptr, 5000));
}

TEST(SessionRaiAssistant, C6ParentCapRace)
{
   const int cap[] = {0, 1024, 4};
   EXPECT_EQ(0, c6LaunchCheck(false, true, false, cap, nullptr, 5000));
}

TEST(SessionRaiAssistant, C6NearKernelCap)
{
   int cap = 0;
   size_t size = sizeof(cap);
   ASSERT_EQ(0, ::sysctlbyname("kern.maxfilesperproc", &cap, &size, nullptr, 0));
   ASSERT_GT(cap, 5000);
   const int failed[] = {-1, 0, 4};
   const int oversized[] = {0, 1048577, 4};
   EXPECT_EQ(0, c6LaunchCheck(false, true, false, nullptr, nullptr, cap - 1));
   EXPECT_EQ(0, c6LaunchCheck(false, true, false, failed, nullptr, cap - 1));
   EXPECT_EQ(0, c6LaunchCheck(true, true, false, oversized, nullptr, cap - 1));
}

TEST(SessionRaiAssistant, C6FallbackExecErrno)
{
   const int cap[] = {-1, 0, 4};
   EXPECT_EQ(0, c6LaunchCheck(false, true, true, cap, nullptr, 5000));
}

TEST(SessionRaiAssistant, C6CloseLoopTiming)
{
   int cap = 0;
   size_t size = sizeof(cap);
   ASSERT_EQ(0, ::sysctlbyname("kern.maxfilesperproc", &cap, &size, nullptr, 0));
   ASSERT_GT(cap, 1024);
   std::vector<double> samples, launches;
   for (int i = 0; i < 30; ++i)
   {
      auto launchStart = std::chrono::steady_clock::now();
      ASSERT_EQ(0, c6LaunchCheck(false, false, false));
      launches.push_back(std::chrono::duration<double, std::milli>(
         std::chrono::steady_clock::now() - launchStart).count());
      int pipe[2];
      ASSERT_EQ(0, ::pipe(pipe));
      pid_t child = ::fork();
      ASSERT_GE(child, 0);
      if (!child)
      {
         ::close(pipe[0]);
         auto start = std::chrono::steady_clock::now();
         raiCloseDescriptorsForTests(cap, pipe[1]);
         double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
         ssize_t written = ::write(pipe[1], &ms, sizeof(ms));
         ::_exit(written == sizeof(ms) ? 0 : 20);
      }
      ::close(pipe[1]);
      double ms = -1;
      EXPECT_EQ(sizeof(ms), ::read(pipe[0], &ms, sizeof(ms)));
      ::close(pipe[0]);
      int status = 0;
      ASSERT_EQ(child, ::waitpid(child, &status, 0));
      ASSERT_EQ(0, status);
      samples.push_back(ms);
   }
   std::sort(samples.begin(), samples.end());
   std::sort(launches.begin(), launches.end());
   std::printf("C6_LAUNCH n=30 p50_ms=%.3f p95_ms=%.3f\n", launches[14], launches[28]);
   std::printf("C6_CLOSE_LOOP cap=%d n=30 p50_ms=%.3f p95_ms=%.3f flag_over_50ms=%d\n",
               cap, samples[14], samples[28], samples[28] > 50);
}
#endif

TEST(SessionRaiAssistant, FormatsLoopbackUrl)
{
   EXPECT_EQ("http://127.0.0.1:8790/", formatBridgeUrl(8790));
}

TEST(SessionRaiAssistant, FormatsArbitraryPort)
{
   EXPECT_EQ("http://127.0.0.1:49213/", formatBridgeUrl(49213));
}

TEST(SessionRaiAssistant, UrlIsLoopbackOnly)
{
   // The client must only ever be pointed at localhost.
   EXPECT_NE(std::string::npos, formatBridgeUrl(1234).find("127.0.0.1"));
   EXPECT_EQ(std::string::npos, formatBridgeUrl(1234).find("0.0.0.0"));
}

// --- RAI startup selection --------------------------------------------------
//
// rai_get_bridge_url must select the RAI bridge and report a reachable bridge
// as "ready". The v0.1.15 regression let a failed (best-effort) workspace
// refresh turn a reachable bridge into a hard "Failed to start backend" error;
// the status classifier has no refresh input at all, so that can no longer
// happen, and these lock that contract.

TEST(SessionRaiAssistant, ReachableBridgeIsReady)
{
   EXPECT_EQ("ready", raiBridgeUrlStatus(false /*startFailed*/, true /*reachable*/));
}

TEST(SessionRaiAssistant, StartedButNotYetListeningIsStarting)
{
   EXPECT_EQ("starting", raiBridgeUrlStatus(false, false));
}

TEST(SessionRaiAssistant, FailedStartIsNotFound)
{
   // A missing node / bridge is not_found regardless of reachability.
   EXPECT_EQ("not_found", raiBridgeUrlStatus(true, false));
   EXPECT_EQ("not_found", raiBridgeUrlStatus(true, true));
}

// --- bridge state file (reconnect + hard reset) -----------------------------

TEST(SessionRaiAssistant, BridgeStateFileRoundTrips)
{
   int port = -1;
   long pid = -1;
   ASSERT_TRUE(parseBridgeStateFile(formatBridgeStateFile(49213, 82931), &port, &pid));
   EXPECT_EQ(49213, port);
   EXPECT_EQ(82931L, pid);
}

TEST(SessionRaiAssistant, BridgeStateFileToleratesLegacyPortOnly)
{
   // A file written before pids were persisted is still usable for reconnect;
   // the pid is simply unknown (-1), which only disables SIGKILL-by-pid.
   int port = -1;
   long pid = 5;
   ASSERT_TRUE(parseBridgeStateFile("49213", &port, &pid));
   EXPECT_EQ(49213, port);
   EXPECT_EQ(-1L, pid);
}

TEST(SessionRaiAssistant, BridgeStateFileTrimsWhitespace)
{
   int port = -1;
   long pid = -1;
   ASSERT_TRUE(parseBridgeStateFile("  49213  \n  82931  \n", &port, &pid));
   EXPECT_EQ(49213, port);
   EXPECT_EQ(82931L, pid);
}

TEST(SessionRaiAssistant, BridgeStateFileRejectsGarbage)
{
   int port = 7;
   long pid = 7;
   EXPECT_FALSE(parseBridgeStateFile("", &port, &pid));
   EXPECT_EQ(-1, port);
   EXPECT_FALSE(parseBridgeStateFile("not-a-port", &port, &pid));
   EXPECT_EQ(-1, port);
}

// --- hard reset failure recovery --------------------------------------------
//
// Persisted PID/port state is untrusted. Hard reset may terminate only the
// process this session itself tracked after matching its live executable,
// command, bridge resource directory, and persisted port context.

RaiResetProcessIdentity expectedBridgeIdentity(long pid, bool alive = true)
{
   RaiResetProcessIdentity identity;
   identity.pid = pid;
   identity.alive = alive;
   identity.portReachable = true;
   identity.executablePath = "/app/bin/node";
   identity.workingDirectory = "/app/rai-chat-bridge";
   identity.startMarker = "spawn-marker";
   identity.arguments = { "/app/bin/node", "server.js" };
   return identity;
}

TEST(SessionRaiAssistant, ResetRejectsMalformedPersistedPid)
{
   EXPECT_EQ(-1L, raiVerifiedResetKillTarget(
      4242L, 49213, -1L, 49213, "/app/bin/node", "/app/rai-chat-bridge", "spawn-marker",
      expectedBridgeIdentity(4242L)));
   EXPECT_EQ(-1L, raiVerifiedResetKillTarget(
      4242L, 49213, 0L, 49213, "/app/bin/node", "/app/rai-chat-bridge", "spawn-marker",
      expectedBridgeIdentity(4242L)));
}

TEST(SessionRaiAssistant, ResetRejectsStalePersistedPid)
{
   EXPECT_EQ(-1L, raiVerifiedResetKillTarget(
      4242L, 49213, 4242L, 49213, "/app/bin/node", "/app/rai-chat-bridge", "spawn-marker",
      expectedBridgeIdentity(4242L, false)));
}

TEST(SessionRaiAssistant, ResetRejectsReusedPidWithWrongProcessIdentity)
{
   RaiResetProcessIdentity reused = expectedBridgeIdentity(4242L);
   reused.executablePath = "/usr/bin/python3";
   EXPECT_EQ(-1L, raiVerifiedResetKillTarget(
      4242L, 49213, 4242L, 49213, "/app/bin/node", "/app/rai-chat-bridge", "spawn-marker", reused));

   reused = expectedBridgeIdentity(4242L);
   reused.arguments = { "/app/bin/node", "unrelated.js" };
   EXPECT_EQ(-1L, raiVerifiedResetKillTarget(
      4242L, 49213, 4242L, 49213, "/app/bin/node", "/app/rai-chat-bridge", "spawn-marker", reused));

   reused = expectedBridgeIdentity(4242L);
   reused.workingDirectory = "/tmp/unrelated";
   EXPECT_EQ(-1L, raiVerifiedResetKillTarget(
      4242L, 49213, 4242L, 49213, "/app/bin/node", "/app/rai-chat-bridge", "spawn-marker", reused));

   reused = expectedBridgeIdentity(4242L);
   reused.startMarker = "reused-process-marker";
   EXPECT_EQ(-1L, raiVerifiedResetKillTarget(
      4242L, 49213, 4242L, 49213, "/app/bin/node", "/app/rai-chat-bridge", "spawn-marker", reused));
}

TEST(SessionRaiAssistant, ResetRejectsUntrackedPersistedBridgePid)
{
   EXPECT_EQ(-1L, raiVerifiedResetKillTarget(
      -1L, -1, 4242L, 49213, "/app/bin/node", "/app/rai-chat-bridge", "spawn-marker",
      expectedBridgeIdentity(4242L)));
}

TEST(SessionRaiAssistant, ResetRejectsMismatchedStatePort)
{
   EXPECT_EQ(-1L, raiVerifiedResetKillTarget(
      4242L, 49213, 4242L, 60000, "/app/bin/node", "/app/rai-chat-bridge", "spawn-marker",
      expectedBridgeIdentity(4242L)));
}

TEST(SessionRaiAssistant, ResetAcceptsExactLiveBridgeIdentity)
{
   EXPECT_EQ(4242L, raiVerifiedResetKillTarget(
      4242L, 49213, 4242L, 49213, "/app/bin/node", "/app/rai-chat-bridge", "spawn-marker",
      expectedBridgeIdentity(4242L)));
}

TEST(SessionRaiAssistant, ResetTerminationPolicyRequiresVerifiedPidAndUsesPlatformHardKill)
{
   EXPECT_EQ(RaiResetTerminationPolicy::None,
             raiResetTerminationPolicy(-1L, false));
   EXPECT_EQ(RaiResetTerminationPolicy::None,
             raiResetTerminationPolicy(-1L, true));
   EXPECT_EQ(RaiResetTerminationPolicy::PosixSigkill,
             raiResetTerminationPolicy(4242L, false));
   EXPECT_EQ(RaiResetTerminationPolicy::WindowsTerminateProcess,
             raiResetTerminationPolicy(4242L, true));
}

TEST(SessionRaiAssistant, DebugAndResultEndpointsAcceptOnlyOpaqueRunIds)
{
   EXPECT_TRUE(raiIsValidRunId("run-abc-123"));
   EXPECT_FALSE(raiIsValidRunId(""));
   EXPECT_FALSE(raiIsValidRunId("run-"));
   EXPECT_FALSE(raiIsValidRunId("../run-abc"));
   EXPECT_FALSE(raiIsValidRunId("run-abc/../../etc"));
   EXPECT_FALSE(raiIsValidRunId("system('unsafe')"));
}

TEST(SessionRaiAssistant, DebugObjectNamesAcceptOnlyBoundedBareIdentifiers)
{
   EXPECT_TRUE(raiIsValidObjectName("object_name"));
   EXPECT_TRUE(raiIsValidObjectName(".hidden_name"));
   EXPECT_FALSE(raiIsValidObjectName(""));
   EXPECT_FALSE(raiIsValidObjectName("x()"));
   EXPECT_FALSE(raiIsValidObjectName("x$y"));
   EXPECT_FALSE(raiIsValidObjectName("x[1]"));
   EXPECT_FALSE(raiIsValidObjectName("base::pi"));
   EXPECT_FALSE(raiIsValidObjectName("two words"));
   EXPECT_FALSE(raiIsValidObjectName("../x"));
   EXPECT_FALSE(raiIsValidObjectName(std::string(129, 'x')));
}

TEST(SessionRaiAssistant, EnvironmentSummaryModeAcceptsOnlyFullOrNrow)
{
   EXPECT_TRUE(raiIsValidSummaryMode("full"));
   EXPECT_TRUE(raiIsValidSummaryMode("nrow"));
   EXPECT_FALSE(raiIsValidSummaryMode(""));
   EXPECT_FALSE(raiIsValidSummaryMode("FULL"));
   EXPECT_FALSE(raiIsValidSummaryMode("all"));
   EXPECT_FALSE(raiIsValidSummaryMode("nrow; 1+1"));
}

TEST(SessionRaiAssistant, RequestedColumnsAcceptOnlyBoundedBareIdentifiers)
{
   // Requested column names reuse the exact same bare-identifier boundary as
   // object_names -- no expression, subscript, or namespace form is ever
   // accepted here either.
   EXPECT_TRUE(raiIsValidObjectName("mpg"));
   EXPECT_FALSE(raiIsValidObjectName("mpg[1]"));
   EXPECT_FALSE(raiIsValidObjectName("mpg$x"));
   EXPECT_FALSE(raiIsValidObjectName(""));
}

TEST(SessionRaiAssistant, Utf8EditorColumnsUseUtf16CodeUnits)
{
   EXPECT_EQ(3, raiUtf8ToUtf16CodeUnitCount("cat"));
   EXPECT_EQ(3, raiUtf8ToUtf16CodeUnitCount("aéb"));
   EXPECT_EQ(4, raiUtf8ToUtf16CodeUnitCount("a😀b"));
}

TEST(SessionRaiAssistant, MonitorEndpointAcceptsOnlyOneOpaqueRunIdAndNeverStartsARun)
{
   const char* const token = "rai-monitor-test-token";
   raiSetSessionEndpointTokenForTests(token);
   raiResetCapture();

   for (const std::string& body : {"", "run_id=../run-x", "run_id=run-x&action=interrupt", "path=/tmp/x"})
   {
      Request request;
      request.setMethod("POST");
      request.setUri("/monitor");
      request.setHeader("X-RAI-Bridge-Token", token);
      request.setBody(body);
      Response response;
      ASSERT_FALSE(invokeProven(raiHandleConsoleMonitorRequestForTests, request, &response));
      EXPECT_EQ(400, response.statusCode()) << body;
   }

   Request request;
   request.setMethod("POST");
   request.setUri("/monitor");
   request.setHeader("X-RAI-Bridge-Token", token);
   request.setBody("run_id=run-observed");
   Response response;
   ASSERT_FALSE(invokeProven(raiHandleConsoleMonitorRequestForTests, request, &response));
   ASSERT_EQ(200, response.statusCode());
   rstudio::core::json::Value parsed;
   ASSERT_FALSE(parsed.parse(response.body()));
   rstudio::core::json::Object result = parsed.getObject();
   EXPECT_EQ("not_running", result["status"].getString());
   EXPECT_EQ("not_running", result["state"].getString());
   EXPECT_TRUE(result.hasMember("console_epoch"));
   EXPECT_TRUE(result.hasMember("console_busy"));
   EXPECT_EQ("run-observed", result["run_id"].getString());
   EXPECT_FALSE(result["session_id"].getString().empty());
   EXPECT_FALSE(raiIsConsoleCaptureCapturing());
   raiSetSessionEndpointTokenForTests("");
}

TEST(SessionRaiAssistant, MonitorEndpointReportsOnlyTheMatchingActiveCapture)
{
   raiResetCapture();
   const char* const token = "rai-monitor-running-test-token";
   raiSetSessionEndpointTokenForTests(token);
   ASSERT_TRUE(raiReserveConsoleCapture("proposal-monitor"));
   ASSERT_TRUE(raiArmConsoleCapture("run-live", "1 + 1", "exact-code-sha256"));

   Request pending;
   pending.setMethod("POST");
   pending.setUri("/monitor");
   pending.setHeader("X-RAI-Bridge-Token", token);
   pending.setBody("run_id=run-live");
   Response pendingResponse;
   ASSERT_FALSE(invokeProven(raiHandleConsoleMonitorRequestForTests, pending, &pendingResponse));
   rstudio::core::json::Value pendingJson;
   ASSERT_FALSE(pendingJson.parse(pendingResponse.body()));
   rstudio::core::json::Object pendingResult = pendingJson.getObject();
   EXPECT_EQ("pending", pendingResult["state"].getString());
   EXPECT_EQ("exact-code-sha256", pendingResult["code_hash"].getString());

   ASSERT_TRUE(raiAcceptConsoleInput("1 + 1"));
   ASSERT_TRUE(raiIsConsoleCaptureCapturing());

   Request matching;
   matching.setMethod("POST");
   matching.setUri("/monitor");
   matching.setHeader("X-RAI-Bridge-Token", token);
   matching.setBody("run_id=run-live");
   Response matchingResponse;
   ASSERT_FALSE(invokeProven(raiHandleConsoleMonitorRequestForTests, matching, &matchingResponse));
   ASSERT_EQ(200, matchingResponse.statusCode());
   rstudio::core::json::Value matchingJson;
   ASSERT_FALSE(matchingJson.parse(matchingResponse.body()));
   rstudio::core::json::Object matchingResult = matchingJson.getObject();
   EXPECT_EQ("running", matchingResult["status"].getString());
   EXPECT_EQ("running", matchingResult["state"].getString());
   EXPECT_EQ("run-live", matchingResult["run_id"].getString());
   EXPECT_FALSE(matchingResult["session_id"].getString().empty());
   EXPECT_GE(matchingResult["elapsed_ms"].getDouble(), 0.0);
   EXPECT_EQ(0.0, matchingResult["output_bytes"].getDouble());
   EXPECT_EQ(0.0, matchingResult["retained_output_bytes"].getDouble());
   EXPECT_EQ(0.0, matchingResult["stdout_bytes"].getDouble());
   EXPECT_EQ(0.0, matchingResult["stderr_bytes"].getDouble());
   EXPECT_EQ(0.0, matchingResult["output_events"].getDouble());
   EXPECT_EQ(-1.0, matchingResult["last_output_age_ms"].getDouble());
   EXPECT_FALSE(matchingResult["output_truncated"].getBool());
   EXPECT_TRUE(matchingResult["stdout"].getString().empty());
   EXPECT_TRUE(matchingResult["stderr"].getString().empty());
   EXPECT_FALSE(matchingResult["tainted"].getBool());

   // Progress counters retain liveness evidence even after the bounded output
   // tail has reached its cap; monitor callers must not misclassify this as a
   // quiet or completed run.
   raiAppendConsoleOutputForTests(false, std::string(300 * 1024, 'x'));
   Response progressedResponse;
   ASSERT_FALSE(invokeProven(raiHandleConsoleMonitorRequestForTests, matching, &progressedResponse));
   rstudio::core::json::Value progressedJson;
   ASSERT_FALSE(progressedJson.parse(progressedResponse.body()));
   rstudio::core::json::Object progressed = progressedJson.getObject();
   EXPECT_EQ("running", progressed["state"].getString());
   EXPECT_EQ(300.0 * 1024.0, progressed["output_bytes"].getDouble());
   EXPECT_EQ(256.0 * 1024.0, progressed["retained_output_bytes"].getDouble());
   EXPECT_EQ(1.0, progressed["output_events"].getDouble());
   EXPECT_TRUE(progressed["output_truncated"].getBool());
   EXPECT_GE(progressed["last_output_age_ms"].getDouble(), 0.0);

   Request wrong;
   wrong.setMethod("POST");
   wrong.setUri("/monitor");
   wrong.setHeader("X-RAI-Bridge-Token", token);
   wrong.setBody("run_id=run-other");
   Response wrongResponse;
   ASSERT_FALSE(invokeProven(raiHandleConsoleMonitorRequestForTests, wrong, &wrongResponse));
   ASSERT_EQ(200, wrongResponse.statusCode());
   rstudio::core::json::Value wrongJson;
   ASSERT_FALSE(wrongJson.parse(wrongResponse.body()));
   rstudio::core::json::Object wrongResult = wrongJson.getObject();
   EXPECT_EQ("not_running", wrongResult["status"].getString());
   EXPECT_TRUE(wrongResult["stdout"].isNull());
   EXPECT_TRUE(wrongResult["stderr"].isNull());
   EXPECT_TRUE(raiIsConsoleCaptureCapturing());
   raiSetSessionEndpointTokenForTests("");
}

// --- single-Console-run exclusion ------------------------------------------
//
// These drive the module's process-global capture slot, so each one resets it
// first and leaves it idle.

class RaiCaptureSlot : public ::testing::Test
{
protected:
   void SetUp() override { raiResetCapture(); }
   void TearDown() override { raiResetCapture(); }
};

TEST_F(RaiCaptureSlot, ReservingAnIdleSlotSucceedsOnce)
{
   EXPECT_TRUE(raiReserveConsoleCapture("proposal-a"));

   // A second proposal cannot reserve the slot while the first holds it. This
   // is what the /run handler turns into "busy", and it is claimed before the R
   // broker is re-entered, so a re-entrant request cannot register a run behind
   // this one's back.
   EXPECT_FALSE(raiReserveConsoleCapture("proposal-b"));
}

TEST_F(RaiCaptureSlot, AReservedSlotIsFreedForTheNextProposal)
{
   EXPECT_TRUE(raiReserveConsoleCapture("digest-a"));
   raiResetCapture();

   // Not queued (approval required, or rejected) releases the slot, or the
   // CLI's next retry of the same proposal could never be approved at all.
   EXPECT_TRUE(raiReserveConsoleCapture("digest-b"));
}

TEST_F(RaiCaptureSlot, ArmingRequiresAHeldReservation)
{
   // Arming without reserving cannot happen: the run would have no slot, and
   // its Console input would be entered with nothing correlating the result.
   EXPECT_FALSE(raiArmConsoleCapture("run-1", "20 + 22"));

   EXPECT_TRUE(raiReserveConsoleCapture("digest-a"));
   EXPECT_TRUE(raiArmConsoleCapture("run-1", "20 + 22"));

   // and the slot is not re-armable for a second run
   EXPECT_FALSE(raiArmConsoleCapture("run-2", "1 + 1"));
}

TEST_F(RaiCaptureSlot, CapturesMultilineSourceDeliveredOneConsoleLineAtATime)
{
   // The Console can emit a queued multiline expression incrementally. Capture
   // begins only once those events reconstruct the exact approved source.
   ASSERT_TRUE(raiReserveConsoleCapture("digest-a"));
   ASSERT_TRUE(raiArmConsoleCapture("run-1", "{\n  x <- 20 + 22\n  print(x)\n}"));

   EXPECT_FALSE(raiAcceptConsoleInput("{"));
   EXPECT_FALSE(raiIsConsoleCaptureCapturing());
   EXPECT_FALSE(raiAcceptConsoleInput("  x <- 20 + 22"));
   EXPECT_FALSE(raiAcceptConsoleInput("  print(x)"));
   EXPECT_TRUE(raiAcceptConsoleInput("}"));
   EXPECT_TRUE(raiIsConsoleCaptureCapturing());
}

TEST_F(RaiCaptureSlot, DoesNotCaptureAnUnrelatedMultilinePrefix)
{
   ASSERT_TRUE(raiReserveConsoleCapture("digest-a"));
   ASSERT_TRUE(raiArmConsoleCapture("run-1", "{\n  x <- 20 + 22\n}"));

   // Sharing a leading brace is not enough: every event must extend the exact
   // approved source in order, otherwise it stays armed and is tainted.
   EXPECT_FALSE(raiAcceptConsoleInput("{"));
   EXPECT_FALSE(raiAcceptConsoleInput("  rm(list = ls())"));
   EXPECT_FALSE(raiIsConsoleCaptureCapturing());
}

TEST_F(RaiCaptureSlot, CapturesWholeMultilineSourceInOneConsoleEvent)
{
   const std::string code = "{\n  x <- 20 + 22\n  print(x)\n}";
   ASSERT_TRUE(raiReserveConsoleCapture("digest-a"));
   ASSERT_TRUE(raiArmConsoleCapture("run-1", code));

   EXPECT_TRUE(raiAcceptConsoleInput(code));
   EXPECT_TRUE(raiIsConsoleCaptureCapturing());
}

TEST_F(RaiCaptureSlot, RetriesRequireExactSourceAndLineBoundInEveryRegisteredState)
{
   const std::string code = "{\n  \"café\"\n}";
   ASSERT_TRUE(raiReserveConsoleCapture("proposal-bound"));
   ASSERT_TRUE(raiArmConsoleCapture("run-bound", code, "", 137));
   for (bool capturing : {false, true})
   {
      if (capturing)
         ASSERT_TRUE(raiAcceptConsoleInput(code));
      std::string runId = "stale";
      bool mismatch = true;
      EXPECT_TRUE(raiInFlightRunForDigest("proposal-bound", code, 137, &runId, &mismatch));
      EXPECT_FALSE(mismatch);
      EXPECT_EQ("run-bound", runId);
      EXPECT_TRUE(raiInFlightRunForDigest("proposal-bound", code + " ", 137, &runId, &mismatch));
      EXPECT_TRUE(mismatch);
      EXPECT_TRUE(runId.empty());
      std::string normalized = code;
      for (std::size_t at = 0; (at = normalized.find(char(10), at)) != std::string::npos; at += 2)
         normalized.insert(at, 1, char(13));
      EXPECT_TRUE(raiInFlightRunForDigest("proposal-bound", normalized, 137, &runId, &mismatch));
      EXPECT_TRUE(mismatch);
      EXPECT_TRUE(runId.empty());
      EXPECT_TRUE(raiInFlightRunForDigest("proposal-bound", code, 138, &runId, &mismatch));
      EXPECT_TRUE(mismatch);
      EXPECT_TRUE(runId.empty());
      EXPECT_FALSE(raiReserveConsoleCapture("unrelated"));
      EXPECT_EQ(capturing, raiIsConsoleCaptureCapturing());
   }
   raiResetCapture();
   std::string runId = "stale";
   bool mismatch = true;
   EXPECT_FALSE(raiInFlightRunForDigest("proposal-bound", code, 137, &runId, &mismatch));
   EXPECT_TRUE(runId.empty());
   EXPECT_FALSE(mismatch);
}

TEST_F(RaiCaptureSlot, ArmingRefusesAnUnboundOrInvalidLineLimit)
{
   ASSERT_TRUE(raiReserveConsoleCapture("proposal-bounds"));
   EXPECT_FALSE(raiArmConsoleCapture("run-bounds", "20 + 22", "", 0));
   EXPECT_FALSE(raiArmConsoleCapture("run-bounds", "20 + 22", "", 1001));
   EXPECT_FALSE(raiArmConsoleCapture("run-bounds", "", "", 200));
   EXPECT_TRUE(raiArmConsoleCapture("run-bounds", "20 + 22", "", 200));
}

TEST_F(RaiCaptureSlot, ARetriedProposalResolvesToTheRunAlreadyQueued)
{
   std::string runId;
   bool payloadMismatch = false;
   EXPECT_TRUE(raiReserveConsoleCapture("digest-a"));
   EXPECT_TRUE(raiArmConsoleCapture("run-1", "20 + 22"));

   // The retry is answered with the run the first request already created,
   // rather than registering a second record or entering the input twice.
   EXPECT_TRUE(raiInFlightRunForDigest("digest-a", "20 + 22", 200, &runId, &payloadMismatch));
   EXPECT_EQ("run-1", runId);
}

TEST_F(RaiCaptureSlot, ARetryBeforeRegistrationReportsNoRunYet)
{
   std::string runId = "unset";
   bool payloadMismatch = false;
   EXPECT_TRUE(raiReserveConsoleCapture("digest-a"));

   // Reserved but not yet registered: the digest matches, but there is no run
   // id to hand back yet, so the handler answers "busy" rather than inventing
   // one.
   EXPECT_TRUE(raiInFlightRunForDigest("digest-a", "20 + 22", 200, &runId, &payloadMismatch));
   EXPECT_EQ("", runId);
}

TEST_F(RaiCaptureSlot, ADifferentProposalIsNeverAnsweredWithAnotherRunsId)
{
   std::string runId;
   bool payloadMismatch = false;
   EXPECT_TRUE(raiReserveConsoleCapture("digest-a"));
   EXPECT_TRUE(raiArmConsoleCapture("run-1", "20 + 22"));

   EXPECT_FALSE(raiInFlightRunForDigest("digest-b", "20 + 22", 200, &runId, &payloadMismatch));
}

TEST_F(RaiCaptureSlot, AnIdleSlotHasNothingInFlight)
{
   std::string runId;
   bool payloadMismatch = false;

   // Nothing is in flight, so an identical proposal is a deliberate re-run: it
   // must get its own approval and its own run id, never a settled run's stale
   // result.
   EXPECT_FALSE(raiInFlightRunForDigest("digest-a", "20 + 22", 200, &runId, &payloadMismatch));

   // An empty digest must never match the empty slot state either.
   EXPECT_FALSE(raiInFlightRunForDigest("", "20 + 22", 200, &runId, &payloadMismatch));
}

// --- /viewer classifier ------------------------------------------------------
//
// Pure: no network, no R, no filesystem. Must never leak the URL it was given
// into kind/transport, and must classify RStudio's own session-temp resource
// URLs distinctly from arbitrary external ones.

TEST(SessionRaiAssistant, ViewerStateInactiveWhenUrlEmpty)
{
   bool active = true;
   std::string kind = "unset";
   std::string transport = "unset";
   raiClassifyViewerState("", true, &active, &kind, &transport);

   EXPECT_FALSE(active);
   EXPECT_EQ("none", kind);
   EXPECT_EQ("none", transport);
}

TEST(SessionRaiAssistant, ViewerStateInactiveIgnoresWidgetFlag)
{
   // Even if a stale widget flag is true, an empty url is still fully inactive.
   bool active = true;
   std::string kind = "unset";
   std::string transport = "unset";
   raiClassifyViewerState("", false, &active, &kind, &transport);

   EXPECT_FALSE(active);
   EXPECT_EQ("none", kind);
   EXPECT_EQ("none", transport);
}

TEST(SessionRaiAssistant, ViewerStateHtmlWidgetOverSessionTempIsClassified)
{
   bool active = false;
   std::string kind;
   std::string transport;
   raiClassifyViewerState("http://127.0.0.1:9876/session/widget-abc/index.html",
                          true, &active, &kind, &transport);

   EXPECT_TRUE(active);
   EXPECT_EQ("html_widget", kind);
   EXPECT_EQ("session_temp", transport);
}

TEST(SessionRaiAssistant, ViewerStateServerModeRelativeSessionTempIsClassified)
{
   // Server-mode relative form ("session/<path>") from sessionTempDirUrl.
   bool active = false;
   std::string kind;
   std::string transport;
   raiClassifyViewerState("session/widget-abc/index.html", true,
                          &active, &kind, &transport);

   EXPECT_TRUE(active);
   EXPECT_EQ("html_widget", kind);
   EXPECT_EQ("session_temp", transport);
}

TEST(SessionRaiAssistant, ViewerStateExternalHttpNonWidgetIsClassified)
{
   bool active = false;
   std::string kind;
   std::string transport;
   raiClassifyViewerState("http://127.0.0.1:4321/custom/app", false,
                          &active, &kind, &transport);

   EXPECT_TRUE(active);
   EXPECT_EQ("other", kind);
   EXPECT_EQ("http", transport);
}

TEST(SessionRaiAssistant, ViewerStateExternalSessionLikeUrlIsNotSessionTemp)
{
   bool active = false;
   std::string kind;
   std::string transport;
   raiClassifyViewerState("https://example.invalid/session/private?token=secret", true,
                          &active, &kind, &transport);

   EXPECT_TRUE(active);
   EXPECT_EQ("html_widget", kind);
   EXPECT_EQ("http", transport);
}

TEST(SessionRaiAssistant, ViewerStateSerializedJsonNeverContainsTheInputUrl)
{
   const std::vector<std::string> urls = {
      "http://127.0.0.1:9876/session/widget-abc/index.html?token=secret",
      "http://example.com/private/report.html#fragment",
      "session/other-widget/index.html"
   };

   for (const std::string& url : urls)
   {
      bool active = false;
      std::string kind;
      std::string transport;
      raiClassifyViewerState(url, true, &active, &kind, &transport);

      // The only strings this classifier ever hands back are the bounded
      // enum-like kind/transport values -- never a substring of the URL, its
      // host, its query, or its fragment.
      EXPECT_NE(kind, url);
      EXPECT_NE(transport, url);
      EXPECT_TRUE(kind == "none" || kind == "html_widget" || kind == "other");
      EXPECT_TRUE(transport == "none" || transport == "session_temp" || transport == "http");
   }
}

// --- project context manifest -----------------------------------------------
//
// get_project_context takes no path argument, so the ONLY directory this walk
// can ever be handed is the session's own project root (or its cwd). These
// lock the other half of that contract: the walk stays inside that root, stops
// one level down, is capped, is deterministic, never follows a symlink out,
// and never emits an absolute path or file contents.

namespace {

// Unique temp directory, removed at scope exit. Nothing here touches the
// session's real project or cwd.
class RaiTempDir
{
public:
   RaiTempDir()
   {
      Error error = FilePath::tempFilePath(path_);
      if (!error)
         error = path_.ensureDirectory();
      if (error)
         ADD_FAILURE() << "could not create temp directory: " << error.asString();
   }

   ~RaiTempDir()
   {
      Error error = path_.removeIfExists();
      if (error)
         ADD_FAILURE() << "could not remove temp directory: " << error.asString();
   }

   const FilePath& path() const { return path_; }

private:
   FilePath path_;
};

void raiWriteTestFile(const FilePath& file, const std::string& contents)
{
   Error error = file.getParent().ensureDirectory();
   if (!error)
      error = rstudio::core::writeStringToFile(file, contents);
   if (error)
      ADD_FAILURE() << "could not write " << file.getAbsolutePath() << ": " << error.asString();
}

std::vector<std::string> raiManifestPaths(const std::vector<RaiProjectFileEntry>& files)
{
   std::vector<std::string> paths;
   for (const RaiProjectFileEntry& file : files)
      paths.push_back(file.path);
   return paths;
}

bool raiManifestHas(const std::vector<RaiProjectFileEntry>& files, const std::string& path)
{
   const std::vector<std::string> paths = raiManifestPaths(files);
   return std::find(paths.begin(), paths.end(), path) != paths.end();
}

} // anonymous namespace

TEST(SessionRaiAssistant, BridgeLogTailPreservesExactBoundedBytes)
{
   RaiTempDir dir;
   const FilePath file = dir.path().completeChildPath("bridge.log");
   const char suffix[] = {'a', 'b', 0, 'c', 'd', 13, 10, 'z'};
   const std::string bytes(suffix, sizeof(suffix));
   ASSERT_FALSE(rstudio::core::writeStringToFileAtomic(file, bytes,
      rstudio::core::string_utils::LineEndingPassthrough));
   EXPECT_EQ(bytes, readFileTail(file, bytes.size() + 1));
   EXPECT_EQ(bytes, readFileTail(file, std::numeric_limits<std::size_t>::max()));
   EXPECT_EQ(bytes, readFileTail(file, bytes.size()));
   EXPECT_EQ(bytes.substr(bytes.size() - 5), readFileTail(file, 5));
   EXPECT_TRUE(readFileTail(file, 0).empty());
   const std::string larger = std::string(65536, 'x') + bytes;
   ASSERT_FALSE(rstudio::core::writeStringToFileAtomic(file, larger,
      rstudio::core::string_utils::LineEndingPassthrough));
   EXPECT_EQ(larger.substr(larger.size() - 2000), readFileTail(file, 2000));
}

TEST(SessionRaiAssistant, BridgeLogTailRejectsUnavailableInputs)
{
   RaiTempDir dir;
   const FilePath file = dir.path().completeChildPath("empty.log");
   ASSERT_FALSE(rstudio::core::writeStringToFileAtomic(file, "",
      rstudio::core::string_utils::LineEndingPassthrough));
   EXPECT_TRUE(readFileTail(file, 2000).empty());
   EXPECT_TRUE(readFileTail(dir.path().completeChildPath("missing.log"), 2000).empty());
   EXPECT_TRUE(readFileTail(dir.path(), 2000).empty());
}

TEST(SessionRaiAssistant, BridgeLogTailHasNoWholeFileRead)
{
   // The release build remaps __FILE__, so RAI_SOURCE_DIR (the source root) is how this test finds the implementation.
   const char* sourceDir = std::getenv("RAI_SOURCE_DIR");
   const FilePath implementation = sourceDir != nullptr
      ? FilePath(sourceDir).completeChildPath("src/cpp/session/modules/SessionRaiAssistant.cpp")
      : FilePath(__FILE__).getParent().completeChildPath("SessionRaiAssistant.cpp");
   std::string source;
   if (rstudio::core::readStringFromFile(implementation, &source))
      GTEST_SKIP() << "implementation source not readable; set RAI_SOURCE_DIR to the source root";
   const auto start = source.find("std::string readFileTail(");
   ASSERT_NE(std::string::npos, start);
   const auto end = source.find("\n}\n", start);
   ASSERT_NE(std::string::npos, end);
   const auto body = source.substr(start, end - start);
   EXPECT_EQ(std::string::npos, body.find("readStringFromFile"));
}

TEST(SessionRaiAssistant, SettingsRevisionMatchesPassthroughWriterBytes)
{
   RaiTempDir dir;
   const FilePath file = dir.path().completeChildPath("assistant.json");
   // Byte-boundary witness only, not a claim that the settings parser accepts BOM.
   const std::string bytes = "\xef\xbb\xbf{\r\n  \"globalPrompt\": \"Explain what this code does. \xf0\x9f\x98\x80\"\r\n}";
   ASSERT_FALSE(rstudio::core::writeStringToFileAtomic(
      file, bytes, rstudio::core::string_utils::LineEndingPassthrough));
   std::string disk;
   ASSERT_FALSE(rstudio::core::readStringFromFile(file, &disk));
   ASSERT_EQ(bytes, disk);
   std::string revision, expected;
   ASSERT_FALSE(raiSettingsRevision(bytes, &revision));
   ASSERT_FALSE(rstudio::core::system::crypto::sha256Hex(disk, &expected));
   EXPECT_EQ(expected, revision);
}

TEST(SessionRaiAssistant, SettingsCommittedRevisionDoesNotAdoptOutsideReplacement)
{
   RaiTempDir dir;
   const FilePath file = dir.path().completeChildPath("assistant.json");
   const std::string committed = "{\n  \"theme\": \"dark\"\n}";
   const std::string replacement = "{\n  \"theme\": \"light\"\n}";
   ASSERT_FALSE(rstudio::core::writeStringToFileAtomic(
      file, committed, rstudio::core::string_utils::LineEndingPassthrough));
   ASSERT_FALSE(rstudio::core::writeStringToFileAtomic(
      file, replacement, rstudio::core::string_utils::LineEndingPassthrough));
   std::string revision, expected, disk, diskRevision;
   ASSERT_FALSE(raiSettingsRevision(committed, &revision));
   ASSERT_FALSE(rstudio::core::system::crypto::sha256Hex(committed, &expected));
   ASSERT_FALSE(rstudio::core::readStringFromFile(file, &disk));
   ASSERT_EQ(replacement, disk);
   ASSERT_FALSE(raiSettingsRevision(disk, &diskRevision));
   EXPECT_EQ(expected, revision);
   // Existing native stale comparison must reject the old commit revision.
   EXPECT_NE(diskRevision, revision);
}

TEST(SessionRaiAssistant, ProjectFileKindIsDerivedFromTheExtensionAlone)
{
   EXPECT_EQ("r_script", raiProjectFileKind("analysis.R"));
   EXPECT_EQ("r_script", raiProjectFileKind("analysis.r"));
   EXPECT_EQ("r_markdown", raiProjectFileKind("report.Rmd"));
   EXPECT_EQ("r_markdown", raiProjectFileKind("report.qmd"));
   EXPECT_EQ("data", raiProjectFileKind("cohort.csv"));
   EXPECT_EQ("data", raiProjectFileKind("counts.rds"));
   EXPECT_EQ("data", raiProjectFileKind("samples.xlsx"));
   EXPECT_EQ("project", raiProjectFileKind("workspace.Rproj"));
   EXPECT_EQ("other", raiProjectFileKind("Makefile"));
   EXPECT_EQ("other", raiProjectFileKind("notes.md"));

   // The kind is a bounded label, never a path fragment: a directory-looking
   // name cannot smuggle its own text into the classification.
   EXPECT_EQ("other", raiProjectFileKind("/etc/passwd"));
   EXPECT_EQ("r_script", raiProjectFileKind("../../secrets.R"));
}

TEST(SessionRaiAssistant, ProjectManifestIsShallowRelativeAndOrdered)
{
   RaiTempDir root;
   raiWriteTestFile(root.path().completeChildPath("analysis.R"), "x <- 1\n");
   raiWriteTestFile(root.path().completeChildPath("workspace.Rproj"), "Version: 1.0\n");
   raiWriteTestFile(root.path().completeChildPath("data/cohort.csv"), "a,b\n1,2\n");
   raiWriteTestFile(root.path().completeChildPath("data/nested/too-deep.csv"), "a\n1\n");

   std::vector<RaiProjectFileEntry> files;
   bool truncated = true;
   raiCollectProjectFiles(root.path(), 200, 2, &files, &truncated);

   EXPECT_FALSE(truncated);
   EXPECT_EQ(std::vector<std::string>({"analysis.R", "data/cohort.csv", "workspace.Rproj"}),
             raiManifestPaths(files));

   // One level below the root is as far as this ever descends.
   EXPECT_FALSE(raiManifestHas(files, "data/nested/too-deep.csv"));

   for (const RaiProjectFileEntry& file : files)
   {
      // Relative only: no absolute path, no parent escape, no separator prefix.
      EXPECT_EQ(std::string::npos, file.path.find(root.path().getAbsolutePath()));
      EXPECT_EQ(std::string::npos, file.path.find(".."));
      EXPECT_NE('/', file.path[0]);
      EXPECT_TRUE(file.kind == "r_script" || file.kind == "data" || file.kind == "project");
   }
   EXPECT_EQ(static_cast<std::uintmax_t>(7), files[0].sizeBytes);
}

TEST(SessionRaiAssistant, ProjectManifestIsCappedAndReportsTruncation)
{
   RaiTempDir root;
   for (int i = 0; i < 12; ++i)
   {
      const std::string name = "file-" + std::string(i < 10 ? "0" : "") +
                               std::to_string(i) + ".R";
      raiWriteTestFile(root.path().completeChildPath(name), "1\n");
   }

   std::vector<RaiProjectFileEntry> files;
   bool truncated = false;
   raiCollectProjectFiles(root.path(), 5, 2, &files, &truncated);

   // A cap is never silent: the caller is told the manifest is partial.
   EXPECT_TRUE(truncated);
   EXPECT_EQ(static_cast<std::size_t>(5), files.size());
   EXPECT_EQ(std::vector<std::string>({"file-00.R", "file-01.R", "file-02.R", "file-03.R", "file-04.R"}),
             raiManifestPaths(files));
}

TEST(SessionRaiAssistant, ProjectManifestSkipsHiddenEntriesAndNeverFollowsSymlinks)
{
   RaiTempDir root;
   RaiTempDir outside;
   raiWriteTestFile(root.path().completeChildPath("analysis.R"), "x <- 1\n");
   raiWriteTestFile(root.path().completeChildPath(".Renviron"), "SECRET=1\n");
   raiWriteTestFile(root.path().completeChildPath(".hidden/creds.csv"), "token\n");
   raiWriteTestFile(outside.path().completeChildPath("private.csv"), "secret\n");

#ifndef _WIN32
   // A symlink is the one way a bounded, root-relative walk could still read
   // outside the project. Neither the link nor its target may appear.
   ASSERT_EQ(0, ::symlink(outside.path().getAbsolutePath().c_str(),
                          root.path().completeChildPath("escape").getAbsolutePath().c_str()));
   ASSERT_EQ(0, ::symlink(outside.path().completeChildPath("private.csv").getAbsolutePath().c_str(),
                          root.path().completeChildPath("linked.csv").getAbsolutePath().c_str()));
#endif

   std::vector<RaiProjectFileEntry> files;
   bool truncated = true;
   raiCollectProjectFiles(root.path(), 200, 2, &files, &truncated);

   EXPECT_FALSE(truncated);
   EXPECT_TRUE(raiManifestHas(files, "analysis.R"));
   EXPECT_FALSE(raiManifestHas(files, ".Renviron"));
   EXPECT_FALSE(raiManifestHas(files, ".hidden/creds.csv"));
#ifndef _WIN32
   EXPECT_FALSE(raiManifestHas(files, "linked.csv"));
   EXPECT_FALSE(raiManifestHas(files, "escape/private.csv"));
   EXPECT_EQ(static_cast<std::size_t>(1), files.size());
#endif
}

TEST(SessionRaiAssistant, WorkingDirectoryIsRelativeToTheRootOrReportedAsOutside)
{
   RaiTempDir root;
   RaiTempDir outside;
   const FilePath nested = root.path().completeChildPath("analysis/scripts");
   ASSERT_FALSE(nested.ensureDirectory());

   EXPECT_EQ(".", raiRelativeWorkingDirectory(root.path(), root.path()));
   EXPECT_EQ("analysis/scripts", raiRelativeWorkingDirectory(root.path(), nested));

   // Outside the root is reported as "no relative form", never as an absolute
   // path and never as a "../.." escape hatch.
   const std::string outsideRelative = raiRelativeWorkingDirectory(root.path(), outside.path());
   EXPECT_TRUE(outsideRelative.empty());
}

// --- plot history index ------------------------------------------------------

TEST(SessionRaiAssistant, PlotIndexMustLandInsideTheLiveHistory)
{
   EXPECT_TRUE(raiIsValidPlotIndex(0, 3));
   EXPECT_TRUE(raiIsValidPlotIndex(2, 3));
   EXPECT_FALSE(raiIsValidPlotIndex(3, 3));
   EXPECT_FALSE(raiIsValidPlotIndex(-1, 3));
   EXPECT_FALSE(raiIsValidPlotIndex(0, 0));
}

TEST(SessionRaiAssistant, PlotIndexFieldAcceptsOnlyABoundedDecimalOrdinal)
{
   int index = -1;
   EXPECT_TRUE(raiParsePlotIndexField("0", &index));
   EXPECT_EQ(0, index);
   EXPECT_TRUE(raiParsePlotIndexField("42", &index));
   EXPECT_EQ(42, index);
   EXPECT_TRUE(raiParsePlotIndexField("999", &index));
   EXPECT_EQ(999, index);

   // Anything that is not a plain bounded ordinal is rejected before the
   // graphics display is touched -- no signs, spaces, expressions, or paths.
   for (const std::string& bad : {"", " 1", "1 ", "-1", "+1", "1.0", "1e3", "0x1",
                                  "1000", "99999", "abc", "1;2", "../1", "/tmp/1"})
   {
      index = -7;
      EXPECT_FALSE(raiParsePlotIndexField(bad, &index)) << "accepted: [" << bad << "]";
      EXPECT_EQ(-1, index) << "left a value for: [" << bad << "]";
   }
}

// --- the capture slot must not give up while its input is still queued -----
//
// Regression for an intermittent failure that produced a WRONG RESULT, not just
// a slow one: run_r reported {"status":"error","error":"console capture timed
// out before the run completed"} for a proposal that then executed anyway. The
// preserved Console from the failure shows both proposals ran in order:
//
//   > stop('RAI_MATRIX_RUNTIME_ERROR')
//   Error: RAI_MATRIX_RUNTIME_ERROR
//   > cat('RAI_MATRIX_CORRECTED=42\n')
//   RAI_MATRIX_CORRECTED=42
//
// enqueueConsoleInput() only queues the approved source; ConsoleInputService
// hands it to R asynchronously. The old rule expired Reserved/Armed purely on
// wall-clock, so a delivery that had not happened yet was reported as a failed
// run -- and then ran. That also taints whichever run holds the slot when the
// abandoned input finally lands, which is why this suite failed several
// different-looking ways. Console input cannot be un-enqueued, so this guard is
// to not give up while it can still arrive.
//
// The delivery stall itself is fixed at source in ConsoleInputService::runImpl
// (a lost wakeup: a non-blocking deque() loop followed by a predicate-less
// wait(), with enque() notifying after releasing the mutex).
//
// The signal here must be a delivered INPUT, not a prompt: rConsoleRead only
// fires consolePrompt when R's own input buffer is EMPTY, i.e. exactly when the
// approved source has not arrived -- so gating on prompts would fire precisely
// in the case this guard exists to protect.

TEST(SessionRaiAssistant, CaptureIsNotExpiredWhileItsInputIsStillQueued)
{
   // No deadline proves that approved queued input can no longer arrive.
   for (int elapsed : {0, 30, 31, 599, 601, 3600})
      EXPECT_FALSE(raiShouldExpireCapture(true, false, elapsed));
}

TEST(SessionRaiAssistant, CaptureIsNotExpiredAfterPartialOrUnrelatedInput)
{
   // An input event does not prove the complete approved source was delivered.
   for (int elapsed : {0, 30, 31, 600, 3600})
      EXPECT_FALSE(raiShouldExpireCapture(true, true, elapsed));
}

TEST(SessionRaiAssistant, ACapturingRunNeedsNativeCompletionNotADeadline)
{
   for (int elapsed : {0, 599, 601, 3600})
   {
      EXPECT_FALSE(raiShouldExpireCapture(false, true, elapsed));
      EXPECT_FALSE(raiShouldExpireCapture(false, false, elapsed));
   }
}

TEST_F(RaiCaptureSlot, FreshRunCannotBorrowPreviousRunsInputPrefix)
{
   const std::string first = "{\n  20 + 22\n}";
   const std::string second = "{\n  40 + 2\n}";
   ASSERT_TRUE(raiReserveConsoleCapture("digest-first"));
   ASSERT_TRUE(raiArmConsoleCapture("run-first", first));
   ASSERT_FALSE(raiAcceptConsoleInput("{"));
   ASSERT_FALSE(raiIsConsoleCaptureCapturing());
   raiResetCapture();

   std::string runId = "stale";
   bool mismatch = true;
   EXPECT_FALSE(raiInFlightRunForDigest("digest-first", first, 200, &runId, &mismatch));
   EXPECT_TRUE(runId.empty());
   EXPECT_FALSE(mismatch);
   ASSERT_TRUE(raiReserveConsoleCapture("digest-second"));
   ASSERT_TRUE(raiArmConsoleCapture("run-second", second));
   ASSERT_TRUE(raiInFlightRunForDigest("digest-second", second, 200, &runId, &mismatch));
   EXPECT_EQ("run-second", runId);
   EXPECT_FALSE(mismatch);

   // B's later lines cannot borrow A's opening brace after reset/re-arm.
   EXPECT_FALSE(raiAcceptConsoleInput("  40 + 2"));
   EXPECT_FALSE(raiAcceptConsoleInput("}"));
   EXPECT_FALSE(raiIsConsoleCaptureCapturing());
   // Positive control: only B's own complete source starts B's capture.
   EXPECT_TRUE(raiAcceptConsoleInput(second));
   EXPECT_TRUE(raiIsConsoleCaptureCapturing());
   EXPECT_TRUE(raiInFlightRunForDigest("digest-second", second, 200, &runId, &mismatch));
   EXPECT_EQ("run-second", runId);
   EXPECT_FALSE(mismatch);
}

// --- /project_context must never fall back to a working directory ----------
//
// get_project_context takes no path argument, so its root is whatever the
// session already has open. That made "no project open" dangerous rather than
// harmless: the root fell back to module_context::safeCurrentPath(), which on
// a fresh desktop session is the user's home directory, so the endpoint
// shipped a 200-entry two-level listing of $HOME -- plus the account name via
// root.getFilename() -- to the provider through a read-only call that raises
// no approval card. The gtest session has no project open, so these tests
// exercise exactly that path.

namespace {

const char* const kProjectContextTestToken = "rai-project-context-test-token";

// http::Request is non-copyable, so this fills one in place rather than
// returning it.
void raiInitProjectContextRequest(Request* pRequest,
                                  const std::string& method,
                                  const std::string& token,
                                  const std::string& body)
{
   pRequest->setMethod(method);
   pRequest->setUri("/project_context");
   if (!token.empty())
      pRequest->setHeader("X-RAI-Bridge-Token", token);
   if (!body.empty())
      pRequest->setBody(body);
}

} // anonymous namespace

TEST(SessionRaiAssistant, ProjectContextGatesMethodTokenAndBody)
{
   raiSetSessionEndpointTokenForTests(kProjectContextTestToken);

   Request getRequest;
   raiInitProjectContextRequest(&getRequest, "GET", kProjectContextTestToken, "");
   Response getResponse;
   ASSERT_FALSE(invokeProven(raiHandleProjectContextRequestForTests, getRequest, &getResponse));
   EXPECT_EQ(405, getResponse.statusCode());

   Request noTokenRequest;
   raiInitProjectContextRequest(&noTokenRequest, "POST", "", "");
   Response noTokenResponse;
   ASSERT_FALSE(invokeProven(raiHandleProjectContextRequestForTests, noTokenRequest, &noTokenResponse));
   EXPECT_EQ(401, noTokenResponse.statusCode());

   Request wrongTokenRequest;
   raiInitProjectContextRequest(&wrongTokenRequest, "POST", "not-the-token", "");
   Response wrongTokenResponse;
   ASSERT_FALSE(invokeProven(raiHandleProjectContextRequestForTests, wrongTokenRequest, &wrongTokenResponse));
   EXPECT_EQ(401, wrongTokenResponse.statusCode());

   // There is no path/dir/glob argument to smuggle, so ANY body is refused.
   for (const std::string& body : {"path=/etc", "directory=..", "recursive=true", "x=1"})
   {
      Request bodyRequest;
      raiInitProjectContextRequest(&bodyRequest, "POST", kProjectContextTestToken, body);
      Response bodyResponse;
      ASSERT_FALSE(invokeProven(raiHandleProjectContextRequestForTests, bodyRequest, &bodyResponse));
      EXPECT_EQ(400, bodyResponse.statusCode()) << "accepted body: [" << body << "]";
   }

   raiSetSessionEndpointTokenForTests("");
}

TEST(SessionRaiAssistant, ProjectContextWithoutAnActiveProjectWalksNothing)
{
   raiSetSessionEndpointTokenForTests(kProjectContextTestToken);

   Request request;
   raiInitProjectContextRequest(&request, "POST", kProjectContextTestToken, "");
   Response response;
   ASSERT_FALSE(invokeProven(raiHandleProjectContextRequestForTests, request, &response));
   ASSERT_EQ(200, response.statusCode());

   rstudio::core::json::Value parsed;
   ASSERT_FALSE(parsed.parse(response.body()));
   ASSERT_TRUE(parsed.isObject());
   rstudio::core::json::Object result = parsed.getObject();

   EXPECT_FALSE(result["project_active"].getBool());

   // The two path-derived fields must be null rather than describing whatever
   // directory the session happens to be sitting in. root_name is the account
   // name when the root is $HOME, which is why it cannot be best-effort.
   EXPECT_TRUE(result["root_name"].isNull());
   EXPECT_TRUE(result["working_directory"].isNull());

   raiSetSessionEndpointTokenForTests("");
}

#ifndef _WIN32
TEST(SessionRaiAssistant, ProjectContextWithoutAProjectLeaksNoHomePathOrAccountName)
{
   const char* const home = ::getenv("HOME");
   if (home == nullptr || *home == '\0')
      GTEST_SKIP() << "HOME is not set";

   raiSetSessionEndpointTokenForTests(kProjectContextTestToken);

   Request request;
   raiInitProjectContextRequest(&request, "POST", kProjectContextTestToken, "");
   Response response;
   ASSERT_FALSE(invokeProven(raiHandleProjectContextRequestForTests, request, &response));
   ASSERT_EQ(200, response.statusCode());
   const std::string body = response.body();

   // A regression that restored the working-directory fallback would put the
   // home path on the wire, and every path fragment contains a separator, so
   // these two raw-body checks catch it wherever it surfaced. Deliberately NOT
   // a substring search for the account name: it is a legitimate substring of
   // the key "root_name" on this machine, so that check reads as a leak when
   // the payload is clean. The account name is caught exactly by root_name
   // being null, asserted on the parsed value below.
   const std::string homePath = home;
   EXPECT_EQ(std::string::npos, body.find(homePath)) << body;
   EXPECT_EQ(std::string::npos, body.find('/')) << body;

   rstudio::core::json::Value parsed;
   ASSERT_FALSE(parsed.parse(body));
   ASSERT_TRUE(parsed.isObject());
   rstudio::core::json::Object result = parsed.getObject();
   EXPECT_TRUE(result["root_name"].isNull()) << body;
   EXPECT_TRUE(result["working_directory"].isNull()) << body;

   raiSetSessionEndpointTokenForTests("");
}
#endif

namespace {
const char* const kReadProjectFileTestToken = "rai-project-file-test-token";
void raiInitReadProjectFileRequest(Request* pRequest, const std::string& method, const std::string& token, const std::string& body)
{
   pRequest->setMethod(method); pRequest->setUri("/file");
   if (!token.empty()) pRequest->setHeader("X-RAI-Bridge-Token", token);
   if (!body.empty()) pRequest->setBody(body);
}
} // anonymous namespace

TEST(SessionRaiAssistant, ReadProjectFileRejectsUnsafePathArgumentsBeforeResolution)
{
   EXPECT_TRUE(raiIsValidProjectRelativePathArgument("notes.txt"));
   EXPECT_TRUE(raiIsValidProjectRelativePathArgument("analysis/scripts/model.R"));
   for (const std::string& path : {"", "/etc/passwd", "\\Windows\\System32", "../secret", "..\\secret", "a/../../secret", "a\\..\\secret", "a/..", "a\\..", "C:\\secret"})
      EXPECT_FALSE(raiIsValidProjectRelativePathArgument(path)) << path;
   EXPECT_FALSE(raiIsValidProjectRelativePathArgument(std::string("notes") + '\0' + ".txt"));
}

TEST(SessionRaiAssistant, ReadProjectFileRejectsBinaryOrMalformedUtf8Text)
{
   EXPECT_TRUE(raiIsBoundedUtf8Text("plain UTF-8 \xE2\x9C\x93"));
   EXPECT_FALSE(raiIsBoundedUtf8Text(std::string("text") + '\0' + "more"));
   EXPECT_FALSE(raiIsBoundedUtf8Text(std::string("bad\xC3", 4)));
}

TEST(SessionRaiAssistant, ReadProjectFileParsesOnlySafePageOffsets)
{
   std::size_t offset = 999;
   EXPECT_TRUE(raiParseProjectFileOffsetField("0", &offset));
   EXPECT_EQ(0u, offset);
   EXPECT_TRUE(raiParseProjectFileOffsetField("65536", &offset));
   EXPECT_EQ(65536u, offset);
   for (const std::string& value : {"", "-1", "+1", "01", "1.0", "1e3", "abc", "184467440737095516160"})
      EXPECT_FALSE(raiParseProjectFileOffsetField(value, &offset)) << value;
}

TEST(SessionRaiAssistant, ReadProjectFileGatesMethodTokenAndInputBeforeNoProject)
{
   raiSetSessionEndpointTokenForTests(kReadProjectFileTestToken);
   Request getRequest; raiInitReadProjectFileRequest(&getRequest, "GET", kReadProjectFileTestToken, "path=notes.txt");
   Response getResponse; ASSERT_FALSE(invokeProven(raiHandleReadProjectFileRequestForTests, getRequest, &getResponse)); EXPECT_EQ(405, getResponse.statusCode());
   Request noTokenRequest; raiInitReadProjectFileRequest(&noTokenRequest, "POST", "", "path=notes.txt");
   Response noTokenResponse; ASSERT_FALSE(invokeProven(raiHandleReadProjectFileRequestForTests, noTokenRequest, &noTokenResponse)); EXPECT_EQ(401, noTokenResponse.statusCode());
   for (const std::string& body : {"", "path=notes.txt&extra=1", "path=../secret", "directory=."})
   {
      Request request; raiInitReadProjectFileRequest(&request, "POST", kReadProjectFileTestToken, body);
      Response response; ASSERT_FALSE(invokeProven(raiHandleReadProjectFileRequestForTests, request, &response)); EXPECT_EQ(400, response.statusCode()) << body;
   }
   Request noProjectRequest; raiInitReadProjectFileRequest(&noProjectRequest, "POST", kReadProjectFileTestToken, "path=notes.txt");
   Response noProjectResponse; ASSERT_FALSE(invokeProven(raiHandleReadProjectFileRequestForTests, noProjectRequest, &noProjectResponse)); EXPECT_EQ(400, noProjectResponse.statusCode());
   EXPECT_NE(std::string::npos, noProjectResponse.body().find("active RStudio project"));
   raiSetSessionEndpointTokenForTests("");
}

TEST(SessionRaiAssistant, NonProtectedProjectReadsReachTheProjectGateAndProtectedOnesDoNot)
{
   raiSetSessionEndpointTokenForTests(kReadProjectFileTestToken);
   for (const std::string& path : {"renv.lock", "cache/model.rda", "secrets_of_success.csv", "secret_santa.csv", "model.profile", "history/data.csv"})
   {
      Request request;
      raiInitReadProjectFileRequest(&request, "POST", kReadProjectFileTestToken, "path=" + path);
      Response response;
      ASSERT_FALSE(invokeProven(raiHandleReadProjectFileRequestForTests, request, &response));
      EXPECT_EQ(400, response.statusCode()) << path;
      EXPECT_NE(std::string::npos, response.body().find("active RStudio project")) << path;
      EXPECT_EQ(std::string::npos, response.body().find("protected environment")) << path;
   }
   for (const std::string& path : {".raistudio/assistant.json", ".RAISTUDIO/mcp.json", "nested/.raistudio/state.json",
                                   ".Renviron", ".Rprofile", ".env", ".env.local", "sub/.env.production", ".zshrc",
                                   ".ssh/id_rsa", "keys/server.pem", "config/credentials.json", ".git/config",
                                   "rsconnect/accounts/connect.example.com/u.dcf", ".Rhistory", ".grok/auth.json",
                                   ".claude.json", "secrets/db.yml", ".git/hooks/pre-commit"})
   {
      Request request;
      raiInitReadProjectFileRequest(&request, "POST", kReadProjectFileTestToken, "path=" + path);
      Response response;
      ASSERT_FALSE(invokeProven(raiHandleReadProjectFileRequestForTests, request, &response));
      EXPECT_EQ(400, response.statusCode()) << path;
      EXPECT_NE(std::string::npos, response.body().find("protected environment")) << path;
      EXPECT_EQ(std::string::npos, response.body().find("active RStudio project")) << path;
   }
   raiSetSessionEndpointTokenForTests("");
}

TEST(SessionRaiAssistant, ProtectedLocationsAreNeverReadable)
{
   for (const std::string& path : {
           "/h/.ssh/id_rsa", "/h/.ssh/config", "/h/.aws/credentials", "/h/.gnupg/pubring.kbx", "/h/.kube/config",
           "/h/.docker/config.json", "/h/.azure/accessTokens.json", "/h/.oci/config", "/h/.kaggle/kaggle.json",
           "/h/.huggingface/token", "/h/.raistudio/assistant.json", "/h/.claude/settings.json", "/h/.codex/auth.json",
           "/h/.gemini/oauth_creds.json", "/h/.cursor/mcp.json", "/h/.config/gcloud/credentials.db",
           "/h/.config/gh/hosts.yml", "/h/.config/op/config", "/h/.config/rclone/rclone.conf",
           "/h/.config/opencode/auth.json", "/h/.config/github-copilot/hosts.json",
           "/h/.config/google-chrome/Default/Cookies", "/h/.local/share/opencode/auth.json",
           "/h/Library/Keychains/login.keychain-db", "/h/Library/Cookies/Cookies.binarycookies",
           "/h/Library/Safari/History.db", "/h/Library/Mail/V10/Envelope Index", "/h/Library/Messages/chat.db",
           "/h/Library/Accounts/Accounts4.sqlite", "/h/Library/LaunchAgents/com.example.plist",
           "/h/Library/LaunchDaemons/com.example.plist",
           "/h/Library/Application Support/Google/Chrome/Default/Login Data",
           "/h/Library/Application Support/Firefox/Profiles/x/cookies.sqlite",
           "/h/.Renviron", "/h/.Renviron.local", "/h/.Rprofile", "/h/Renviron.site", "/h/Rprofile.site", "/h/.env",
           "/h/.env.local", "/h/.envrc", "/h/.netrc", "/h/.npmrc", "/h/.pypirc", "/h/.pgpass", "/h/.my.cnf",
           "/h/.git-credentials", "/h/.databrickscfg", "/h/.vault-token", "/h/.s3cfg", "/h/.boto", "/h/.zshrc",
           "/h/.zshenv", "/h/.zprofile", "/h/.bashrc", "/h/.bash_profile", "/h/.profile", "/h/.zsh_history",
           "/h/.bash_history", "/h/.Rhistory", "/p/credentials", "/p/credentials.json", "/p/secrets.yml",
           "/p/secret.txt", "/p/id_rsa", "/p/id_ed25519", "/p/server.pem", "/p/tls.key", "/p/store.p12",
           "/p/vault.kdbx", "/p/trust.jks", "/p/app.keystore", "/p/putty.ppk", "/p/repo/.git/config",
           "/p/rsconnect/accounts/connect.example.com/u.dcf", "/etc/passwd", "/etc/shadow", "/etc/sudoers",
           "/private/etc/master.passwd", "/proc/1/environ", "/h/.SSH/ID_RSA", "C:\\Users\\a\\.ssh\\id_rsa",
           ".ssh/id_rsa", ".env", "sub/.Renviron",
           "/h/.grok/auth.json", "/h/.grok/config.toml", "/h/.claude.json", "/h/.config/anthropic/api.json",
           "/h/.openai/auth.json", "/h/Library/Application Support/Claude/claude_desktop_config.json",
           "/p/secret/key.txt", "/p/secrets/db.yml", "/p/Secrets/db.yml", "/h/.zlogin", "/h/.zlogout",
           "/h/.login", "/h/.logout", "/h/.inputrc", "/h/.bash_logout", "/h/.cshrc", "/h/.tcshrc",
           "/h/.config/fish/config.fish", "/h/.config/fish/conf.d/x.fish", "/h/.zshrc.local",
           "/p/repo/.git/hooks/pre-commit", "/p/repo/.git/hooks/post-merge.sample",
           "/h/.config/autostart/x.desktop", "/h/.gitconfig", "/h/.R/Makevars", "/h/.R/Makevars-4.6",
           "/etc/sudoers.d/90-local", "/h/.config/git/config", "/h/.zshrc.d/x.zsh", "/h/.oh-my-zsh/custom/x.zsh",
           "/h/.vimrc", "/h/.tmux.conf", "/h/.zsh_sessions/A1.history", "/h/.cache/huggingface/token",
           "/h/.Rapp.history", "/p/repo/.git/modules/sub/hooks/pre-commit"})
      EXPECT_TRUE(raiIsEnvironmentFilePath(path, true)) << path;

   for (const std::string& path : {
           "/p/data/raw.csv", "/p/secrets_of_success.csv", "/p/model.profile", "/p/history/data.csv", "/p/renv.lock",
           "/p/.RData", "/p/results.rda", "/p/envelope.csv", "/p/monkey.csv", "/p/credentials_report.csv",
           "/p/keys_table.csv", "/p/environment.csv", "/p/profile.R", "/p/notes.env.md", "/p/id_rsa.pub",
           "/h/Documents/study/cohort.csv", "/h/Downloads/table.xlsx", "/h/.config/rstudio/rstudio-prefs.json",
           "/h/Library/Application Support/RStudio/monitored-lists/file_mru", "/p/R/analysis.R", "/p/report.Rmd",
           "/p/secret_santa.csv", "/p/secretary/notes.csv", "/p/secrets_of_success.R", "/p/claude.json",
           "/p/grok/notes.csv", "/p/hooks/helper.R", "/p/autostart/x.R", "/p/fish/x.csv", "/p/login.csv",
           "/p/repo/.git/HEAD", "/h/Library/Application Support/Claudette/x.json",
           "/h/.config/anthropic-notes/x.csv", "/h/.openai-notes/x.csv", "/h/.grokking/x.csv", "/p/gitconfig.txt",
           "/p/Makevars", "/p/R/Makevars.md", "/p/sudoers.d.csv"})
      EXPECT_FALSE(raiIsEnvironmentFilePath(path, true)) << path;
}

TEST(SessionRaiAssistant, ProtectedLocationMatcherTreatsEmbeddedNewlinesAsOrdinaryCharacters)
{
// R's PCRE does not let ^ or $ match at an embedded newline, so neither may the native matcher.
   for (const std::string& path : {"/p/safe.txt\nid_rsa", "/p/safe.txt\n.Renviron", "/p/a.csv\n/etc/passwd",
                                   "/p/a.csv\n.ssh/x", "/p/a.csv\n.env", "/p/a.csv\ncredentials"})
      EXPECT_FALSE(raiIsEnvironmentFilePath(path, true)) << path;
   EXPECT_TRUE(raiIsEnvironmentFilePath("/h/.ssh/id_rsa", true));
   EXPECT_TRUE(raiIsEnvironmentFilePath("/p/a\nb/.ssh/id_rsa", true));
}

#ifndef _WIN32
TEST(SessionRaiAssistant, ProtectedLocationChecksFollowTheCanonicalPathOfASymlink)
{
   RaiTempDir root;
   const FilePath target = root.path().completeChildPath("project/.ssh/id_rsa");
   raiWriteTestFile(target, "RAI_DUMMY");
   const FilePath link = root.path().completeChildPath("project/notes.txt");
   ASSERT_EQ(0, ::symlink(target.getAbsolutePath().c_str(), link.getAbsolutePath().c_str()));
   EXPECT_FALSE(raiIsEnvironmentFilePath(link.getAbsolutePath(), true));
   EXPECT_TRUE(raiIsEnvironmentFilePath(link.getCanonicalPath(), true));
   EXPECT_TRUE(raiIsEnvironmentFilePath(target.getCanonicalPath(), true));
}
#endif

TEST(SessionRaiAssistant, OwnerTokenIsReadFromNativeMemoryNotTheEnvironment)
{
   ASSERT_EQ(nullptr, std::getenv("RAI_OWNER_TOKEN"));
   raiSetSessionEndpointTokenForTests("rai-owner-unit-token");
   std::string token;
   ASSERT_FALSE(rstudio::r::exec::RFunction(".rs.rai.ownerToken").call(&token));
   EXPECT_EQ("rai-owner-unit-token", token);
   EXPECT_EQ(nullptr, std::getenv("RAI_OWNER_TOKEN"));
   raiSetSessionEndpointTokenForTests("");
   ASSERT_FALSE(rstudio::r::exec::RFunction(".rs.rai.ownerToken").call(&token));
   EXPECT_EQ("", token);
}

TEST(SessionRaiAssistant, AnchoredEditRequiresExpectedTextToOccurExactlyOnce)
{
   std::size_t matchStart = 999;
   EXPECT_EQ(RaiAnchorValidation::kNotUnique,
             raiValidateAnchoredEdit("no match here", "x <- 1", "", "", &matchStart));
   EXPECT_EQ(RaiAnchorValidation::kNotUnique,
             raiValidateAnchoredEdit("x <- 1\nx <- 1", "x <- 1", "", "", &matchStart));
   // Overlapping occurrences are still ambiguous; never select the first one.
   EXPECT_EQ(RaiAnchorValidation::kNotUnique,
             raiValidateAnchoredEdit("aaa", "aa", "", "", &matchStart));
   EXPECT_EQ(RaiAnchorValidation::kNotUnique,
             raiValidateAnchoredEdit("aaaa", "aaa", "", "", &matchStart));

   matchStart = 999;
   EXPECT_EQ(RaiAnchorValidation::kOk,
             raiValidateAnchoredEdit("a\nx <- 1\nb", "x <- 1", "", "", &matchStart));
   EXPECT_EQ(2u, matchStart);
}

TEST(SessionRaiAssistant, AnchoredEditRequiresLiteralAdjacentContextWhenSupplied)
{
   const std::string doc = "## Header\n```{r}\nx <- 1\n```\n";
   std::size_t matchStart = 999;

   // Exact, immediately-adjacent context on both sides matches.
   EXPECT_EQ(RaiAnchorValidation::kOk,
             raiValidateAnchoredEdit(doc, "x <- 1", "```{r}\n", "\n```", &matchStart));
   EXPECT_EQ(doc.find("x <- 1"), matchStart);

   // Context that exists elsewhere in the document, but is not adjacent to
   // the match, is rejected rather than matched loosely.
   EXPECT_EQ(RaiAnchorValidation::kContextMismatch,
             raiValidateAnchoredEdit(doc, "x <- 1", "## Header\n", "\n```", &matchStart));

   // Stale context (plausible text that simply isn't there) is rejected.
   EXPECT_EQ(RaiAnchorValidation::kContextMismatch,
             raiValidateAnchoredEdit(doc, "x <- 1", "```{r}\n", "\n# stale\n```", &matchStart));

   // A context string longer than what precedes the match is rejected, not a
   // crash or an out-of-bounds read.
   EXPECT_EQ(RaiAnchorValidation::kContextMismatch,
             raiValidateAnchoredEdit(doc, "x <- 1", std::string(doc.size(), 'z'), "", &matchStart));

   // Empty context strings mean "not supplied" and are never checked.
   EXPECT_EQ(RaiAnchorValidation::kOk,
             raiValidateAnchoredEdit(doc, "x <- 1", "", "", &matchStart));
}

TEST(SessionRaiAssistant, RMarkdownDocumentsRequireEditContextROnesDoNot)
{
   EXPECT_TRUE(raiDocumentEditRequiresContext("r_markdown"));
   EXPECT_FALSE(raiDocumentEditRequiresContext("r_source"));
   EXPECT_FALSE(raiDocumentEditRequiresContext(""));
}

// Regression for the QA-reported edit_document result contract bug: the
// live MCP/bridge-facing response for a Full Auto edit_document request
// showed `"approval": ["autonomous"]` (an array) instead of a bare string,
// and a cached-result poll after apply showed `trace.seq: null` instead of
// the actual sequence number -- both caused by r::json::jsonValueFromList
// marshaling every length-1 R atomic vector as a JSON array. This proves
// the normalization fixes both shapes without touching any field not in the
// explicit allow-list, and without altering a legitimately multi-element or
// already-scalar value.
// Minimal regression for copying an Object view back onto its owning Value:
// the view and Value share a RapidJSON Document, so CopyFrom(self) is invalid.
TEST(SessionRaiAssistant, UnwrapSingleElementArrayPreservesWholeDocument)
{
   rstudio::core::json::Object input;
   rstudio::core::json::Array status;
   status.push_back("applied");
   input["status"] = status;
   input["sentinel"] = "intact";
   rstudio::core::json::Value value = input;

   raiUnwrapSingleElementArrays(&value, {"status"});

   rstudio::core::json::Value expected;
   ASSERT_FALSE(expected.parse("{\"status\":\"applied\",\"sentinel\":\"intact\"}"));
   EXPECT_EQ(expected.write(), value.write());
}

TEST(SessionRaiAssistant, UnwrapSingleElementArraysNormalizesOnlyNamedScalarFields)
{
   {
      rstudio::core::json::Object object;
      rstudio::core::json::Array approval; approval.push_back("autonomous");
      object["approval"] = approval;
      rstudio::core::json::Array status; status.push_back("applying");
      object["status"] = status;
      rstudio::core::json::Array requestId; requestId.push_back("req-1");
      object["request_id"] = requestId;
      rstudio::core::json::Value value = object;

      raiUnwrapSingleElementArrays(&value, {"status", "approval", "request_id", "document_id",
                                            "message", "policy", "file", "seq"});

      rstudio::core::json::Object result = value.getObject();
      ASSERT_TRUE(result["approval"].isString());
      EXPECT_EQ("autonomous", result["approval"].getString());
      ASSERT_TRUE(result["status"].isString());
      EXPECT_EQ("applying", result["status"].getString());
      ASSERT_TRUE(result["request_id"].isString());
      EXPECT_EQ("req-1", result["request_id"].getString());
   }

   // Nested {file, seq} trace-link object: seq must come back as a bare
   // integer, not [1] -- this is the exact trace_seq: null symptom (a
   // caller that does `result.trace?.seq ?? null` on a 1-element array
   // sees null because the array itself, not its element, is truthy but
   // not a number).
   {
      rstudio::core::json::Object trace;
      rstudio::core::json::Array seq; seq.push_back(1);
      trace["seq"] = seq;
      rstudio::core::json::Array file; file.push_back("rai-trace-20260926.jsonl");
      trace["file"] = file;
      rstudio::core::json::Array untouched; untouched.push_back("keep-array");
      trace["capabilities"] = untouched;
      rstudio::core::json::Object other;
      rstudio::core::json::Array otherSeq; otherSeq.push_back(7);
      other["seq"] = otherSeq;

      rstudio::core::json::Object object;
      object["status"] = "applied";
      object["trace"] = trace;
      object["other"] = other;
      rstudio::core::json::Value value = object;

      raiUnwrapSingleElementArrays(&value, {"status", "approval", "request_id", "document_id",
                                            "message", "policy", "file", "seq"});

      rstudio::core::json::Object result = value.getObject();
      rstudio::core::json::Object resultTrace = result["trace"].getObject();
      ASSERT_TRUE(resultTrace["seq"].isInt());
      EXPECT_EQ(1, resultTrace["seq"].getInt());
      ASSERT_TRUE(resultTrace["file"].isString());
      EXPECT_EQ("rai-trace-20260926.jsonl", resultTrace["file"].getString());
      EXPECT_TRUE(resultTrace["capabilities"].isArray());
      EXPECT_TRUE(result["other"].getObject()["seq"].isArray());
   }

   // A field not in the allow-list (e.g. a hypothetical "capabilities"
   // array elsewhere in this RPC family) must never be touched, even if it
   // happens to have exactly one element -- this is the safety property the
   // allow-list exists to guarantee.
   {
      rstudio::core::json::Object object;
      rstudio::core::json::Array capabilities; capabilities.push_back("health");
      object["capabilities"] = capabilities;
      object["status"] = "ok";
      rstudio::core::json::Value value = object;

      raiUnwrapSingleElementArrays(&value, {"status", "approval", "request_id", "document_id",
                                            "message", "policy", "file", "seq"});

      rstudio::core::json::Object result = value.getObject();
      ASSERT_TRUE(result["capabilities"].isArray());
      EXPECT_EQ(1, static_cast<int>(result["capabilities"].getArray().getSize()));
   }

   // A field with 2+ elements must never be collapsed, even if it is named
   // in the allow-list -- only exact 1-element arrays are scalars-in-disguise.
   {
      rstudio::core::json::Object object;
      rstudio::core::json::Array status; status.push_back("applied"); status.push_back("stale");
      object["status"] = status;
      rstudio::core::json::Value value = object;

      raiUnwrapSingleElementArrays(&value, {"status"});

      rstudio::core::json::Object result = value.getObject();
      ASSERT_TRUE(result["status"].isArray());
      EXPECT_EQ(2u, result["status"].getArray().getSize());
   }

   // Already-scalar fields (a caller that already returned a bare string)
   // are left untouched -- this function is safe to apply unconditionally
   // regardless of whether the R-side marshaling bug is present.
   {
      rstudio::core::json::Object object;
      object["status"] = "applied";
      rstudio::core::json::Value value = object;

      raiUnwrapSingleElementArrays(&value, {"status"});

      rstudio::core::json::Object result = value.getObject();
      ASSERT_TRUE(result["status"].isString());
      EXPECT_EQ("applied", result["status"].getString());
   }
}

// getRunResult's trace object uses queued_seq/completed_seq (not the bare
// "seq" key edit_document uses) -- confirms handleRunResultRequest's actual
// allow-list (which includes both nested key names) round-trips real R
// output. Regression for the missing-unwrap defect that made
// rai-console-roundtrip / rai-console-stage1-debugging-matrix time out
// waiting on a status the fake provider's `status === 'ok'` check never saw.
TEST(SessionRaiAssistant, GetRunResultUnwrapsQueuedAndCompletedSeq)
{
   rstudio::core::json::Object trace;
   rstudio::core::json::Array queuedSeq; queuedSeq.push_back(3);
   trace["queued_seq"] = queuedSeq;
   rstudio::core::json::Array completedSeq; completedSeq.push_back(4);
   trace["completed_seq"] = completedSeq;
   rstudio::core::json::Array file; file.push_back("rai-trace-20260926.jsonl");
   trace["file"] = file;

   rstudio::core::json::Object object;
   rstudio::core::json::Array status; status.push_back("applied");
   object["status"] = status;
   rstudio::core::json::Array runId; runId.push_back("run-1");
   object["run_id"] = runId;
   rstudio::core::json::Array stdoutText; stdoutText.push_back("RAI_E2E_ORIG_SUM 12\n");
   object["stdout"] = stdoutText;
   rstudio::core::json::Array tainted; tainted.push_back(false);
   object["tainted"] = tainted;
   rstudio::core::json::Array elapsedMs; elapsedMs.push_back(12);
   object["elapsed_ms"] = elapsedMs;
   rstudio::core::json::Object dataEffects;
   rstudio::core::json::Array created; created.push_back("derived");
   dataEffects["bindings_created"] = created;
   object["data_effects"] = dataEffects;
   object["trace"] = trace;
   rstudio::core::json::Value value = object;

   raiUnwrapSingleElementArrays(&value, {"status", "run_id", "message", "approval",
                                         "stdout", "stderr", "error", "value_summary",
                                         "visible", "elapsed_ms", "completion", "console_epoch",
                                         "output_bytes", "condition_state", "native_error_text",
                                         "code_hash", "outcome_verification", "tainted",
                                         "taint_reason", "file", "seq", "queued_seq",
                                         "completed_seq"});

   rstudio::core::json::Object result = value.getObject();
   ASSERT_TRUE(result["status"].isString());
   EXPECT_EQ("applied", result["status"].getString());
   ASSERT_TRUE(result["run_id"].isString());
   EXPECT_EQ("run-1", result["run_id"].getString());
   ASSERT_TRUE(result["stdout"].isString());
   EXPECT_EQ("RAI_E2E_ORIG_SUM 12\n", result["stdout"].getString());
   ASSERT_TRUE(result["tainted"].isBool());
   EXPECT_FALSE(result["tainted"].getBool());
   ASSERT_TRUE(result["elapsed_ms"].isInt());
   EXPECT_EQ(12, result["elapsed_ms"].getInt());
   EXPECT_TRUE(result["data_effects"].getObject()["bindings_created"].isArray());
   rstudio::core::json::Object resultTrace = result["trace"].getObject();
   ASSERT_TRUE(resultTrace["queued_seq"].isInt());
   EXPECT_EQ(3, resultTrace["queued_seq"].getInt());
   ASSERT_TRUE(resultTrace["completed_seq"].isInt());
   EXPECT_EQ(4, resultTrace["completed_seq"].getInt());
   ASSERT_TRUE(resultTrace["file"].isString());
   EXPECT_EQ("rai-trace-20260926.jsonl", resultTrace["file"].getString());
}

TEST(SessionRaiAssistant, EnvironmentAndProfileFilesAreNeverEditTargets)
{
   EXPECT_TRUE(raiIsEnvironmentFilePath("/Users/u/.Rprofile"));
   EXPECT_TRUE(raiIsEnvironmentFilePath("/Users/u/proj/.Renviron"));
   EXPECT_TRUE(raiIsEnvironmentFilePath("C:\\proj\\.RData"));
   EXPECT_TRUE(raiIsEnvironmentFilePath("/p/cache/model.rda"));
   EXPECT_TRUE(raiIsEnvironmentFilePath("/p/cache/Model.RDATA"));
   EXPECT_TRUE(raiIsEnvironmentFilePath("/p/renv.lock"));
   EXPECT_TRUE(raiIsEnvironmentFilePath("/Users/u/.raistudio/assistant.json"));
   EXPECT_FALSE(raiIsEnvironmentFilePath(""));
   EXPECT_FALSE(raiIsEnvironmentFilePath("/p/R/analysis.R"));
   EXPECT_FALSE(raiIsEnvironmentFilePath("/p/report.Rmd"));
   EXPECT_FALSE(raiIsEnvironmentFilePath("/p/R/Rprofile_helpers.R"));
   for (const std::string& path : {"/p/.Renviron", "/p/.Rprofile", "/p/.env", "/p/.env.local", "/p/renv.lock", "C:\\p\\model.rda"})
   {
      EXPECT_TRUE(raiIsEnvironmentFilePath(path));
      EXPECT_TRUE(raiIsEnvironmentFilePath(path, false));
   }
   for (const std::string& path : {"/p/.Renviron", "/p/.Rprofile", "/p/.env", "/p/.env.local"})
      EXPECT_TRUE(raiIsEnvironmentFilePath(path, true)) << path;
   for (const std::string& path : {"/p/renv.lock", "C:\\p\\model.rda", "/p/.RData"})
      EXPECT_FALSE(raiIsEnvironmentFilePath(path, true)) << path;
   for (const std::string& path : {"/p/.raistudio/assistant.json", "/p/.RAISTUDIO/mcp.json", "C:\\p\\.raistudio\\state.json"})
   {
      EXPECT_TRUE(raiIsEnvironmentFilePath(path));
      EXPECT_TRUE(raiIsEnvironmentFilePath(path, true));
   }
}

TEST(SessionRaiAssistant, BufferAuditStructurePreservesEveryBlankLineIncludingTrailing)
{
   const RaiBufferAudit empty = raiAuditBufferStructure("");
   EXPECT_EQ(1, empty.totalLines);
   EXPECT_EQ(1, empty.blankLines);

   const RaiBufferAudit noTrailingNewline = raiAuditBufferStructure("a\n\nb");
   EXPECT_EQ(3, noTrailingNewline.totalLines);
   EXPECT_EQ(1, noTrailingNewline.blankLines);

   // A trailing newline yields one more (blank) line -- the exact case an
   // R strsplit()-based line count silently drops.
   const RaiBufferAudit trailingNewline = raiAuditBufferStructure("a\nb\n");
   EXPECT_EQ(3, trailingNewline.totalLines);
   EXPECT_EQ(1, trailingNewline.blankLines);

   const RaiBufferAudit fenced = raiAuditBufferStructure("```{r}\nx <- 1\n```\n");
   EXPECT_EQ(2, fenced.fenceCount);
}

TEST(SessionRaiAssistant, BufferChangeIsExpectedOnlyWhenTheDeltaMatchesTheSubstitutionAlone)
{
   const RaiBufferAudit before = raiAuditBufferStructure("x <- 1\ny <- 2\n");
   const RaiBufferAudit afterIntended = raiAuditBufferStructure("x <- 10\ny <- 2\n");
   EXPECT_TRUE(raiBufferChangeIsExpected(before, afterIntended, "1", "10"));

   // Same expected/replacement pair (predicted delta: 0 lines), but the
   // "after" buffer also picked up an unrelated extra line -- something
   // beyond the requested edit changed, so this must be rejected.
   const RaiBufferAudit afterWithExtraLine = raiAuditBufferStructure("x <- 10\ny <- 2\nz <- 3\n");
   EXPECT_FALSE(raiBufferChangeIsExpected(before, afterWithExtraLine, "1", "10"));

   // Predicted fence delta is 0 (neither expected nor replacement touches a
   // fence), but the "after" buffer gained an unrelated second fenced chunk.
   const RaiBufferAudit beforeFence = raiAuditBufferStructure("```{r}\nx <- 1\n```\n");
   const RaiBufferAudit afterUnrelatedFenceAdded =
      raiAuditBufferStructure("```{r}\nx <- 10\n```\n```{r}\ny <- 2\n```\n");
   EXPECT_FALSE(raiBufferChangeIsExpected(beforeFence, afterUnrelatedFenceAdded, "x <- 1", "x <- 10"));
}

namespace {
const char* const kDocumentEditTestToken = "rai-document-edit-test-token";
void raiInitDocumentEditRequest(Request* pRequest, const std::string& method, const std::string& token, const std::string& body)
{
   pRequest->setMethod(method); pRequest->setUri("/edit");
   if (!token.empty()) pRequest->setHeader("X-RAI-Bridge-Token", token);
   if (!body.empty()) pRequest->setBody(body);
}
} // anonymous namespace

TEST(SessionRaiAssistant, DocumentEditGatesMethodTokenAndFieldShapeBeforeNoOpenDocument)
{
   raiSetSessionEndpointTokenForTests(kDocumentEditTestToken);
   Request getRequest; raiInitDocumentEditRequest(&getRequest, "GET", kDocumentEditTestToken, "document_id=doc-1&expected_text=x&replacement=y");
   Response getResponse; ASSERT_FALSE(invokeProven(raiHandleDocumentEditRequestForTests, getRequest, &getResponse)); EXPECT_EQ(405, getResponse.statusCode());

   Request noTokenRequest; raiInitDocumentEditRequest(&noTokenRequest, "POST", "", "document_id=doc-1&expected_text=x&replacement=y");
   Response noTokenResponse; ASSERT_FALSE(invokeProven(raiHandleDocumentEditRequestForTests, noTokenRequest, &noTokenResponse)); EXPECT_EQ(401, noTokenResponse.statusCode());

   for (const std::string& body : {
           "document_id=doc-1&expected_text=x&replacement=y&extra=1",
           "document_id=doc-1&expected_text=&replacement=y",
           // Only one of the context pair supplied is rejected, not silently
           // treated as "no context".
           "document_id=doc-1&expected_text=x&replacement=y&context_before=a",
           "document_id=doc-1&expected_text=x&replacement=y&context_after=a",
           // Empty context values are rejected once the pair is present.
           "document_id=doc-1&expected_text=x&replacement=y&context_before=&context_after=a"})
   {
      Request request; raiInitDocumentEditRequest(&request, "POST", kDocumentEditTestToken, body);
      Response response; ASSERT_FALSE(invokeProven(raiHandleDocumentEditRequestForTests, request, &response)); EXPECT_EQ(400, response.statusCode()) << body;
   }

   // A well-shaped body (with and without a context pair) passes field
   // validation and fails only because the gtest session has no open
   // document -- proving the earlier 400s were about field shape, not this.
   for (const std::string& body : {
           "document_id=doc-1&expected_text=x&replacement=y",
           "document_id=doc-1&expected_text=x&replacement=y&context_before=a&context_after=b"})
   {
      Request request; raiInitDocumentEditRequest(&request, "POST", kDocumentEditTestToken, body);
      Response response; ASSERT_FALSE(invokeProven(raiHandleDocumentEditRequestForTests, request, &response)); EXPECT_EQ(400, response.statusCode()) << body;
      EXPECT_NE(std::string::npos, response.body().find("open editable")) << body;
   }

   raiSetSessionEndpointTokenForTests("");
}


TEST(SessionRaiAssistant, DeferredMetadataIsExplicitlyUnavailable)
{
   rstudio::r::sexp::Protect protect;
   SEXP result = R_NilValue;
   Error error = rstudio::r::exec::evaluateString(
      "local({ x <- list(1L,2L,3L); attr(x, 'class') <- as.character(1:3); "
      "assign('raiS3Native', x, .GlobalEnv); "
      "on.exit(rm('raiS3Native', envir=.GlobalEnv)); "
      "d <- .Call('rs_raiDataObjectDetail', 'raiS3Native', 'full', character(), PACKAGE='(embedding)'); "
      "stopifnot(identical(d$classes, 'unavailable'), "
      "grepl('unavailable', d$summary, fixed=TRUE)); TRUE })", &result, &protect);
   EXPECT_FALSE(error) << error.getMessage();
}


TEST(SessionRaiAssistant, DeferredMetadataNeverInvokesCallbacks)
{
   rstudio::r::sexp::Protect protect;
   SEXP result = R_NilValue;
   for (int kind = 0; kind < 9; ++kind)
   {
      SCOPED_TRACE(kind);
      SEXP index = Rf_ScalarInteger(kind); protect.add(index);
      SEXP fixture = rai_s3c_fixture(index); protect.add(fixture);
      SEXP symbol = Rf_install("A_raiS3cNative");
      Rf_defineVar(symbol, fixture, R_GlobalEnv);
      for (const char* expression : {
         ".Call('rs_raiSafeObjectSummary', 'A_raiS3cNative', PACKAGE='(embedding)')",
         "stopifnot('A_raiS3cNative' %in% .Call('rs_raiEnvironmentBindings', PACKAGE='(embedding)')$names)",
         ".Call('rs_raiDataObjectDetail', 'A_raiS3cNative', 'full', character(), PACKAGE='(embedding)')",
         ".Call('rs_raiDataObjectDetail', 'A_raiS3cNative', 'nrow', character(), PACKAGE='(embedding)')",
         ".Call('rs_raiDataObjectDetail', 'A_raiS3cNative', 'full', c('a','absent'), PACKAGE='(embedding)')",
         ".Call('rs_raiDataObjectDetail', 'A_raiS3cNative', 'nrow', c('a','absent'), PACKAGE='(embedding)')"})
      {
         SCOPED_TRACE(expression);
         rai_s3c_reset();
         Error error = rstudio::r::exec::evaluateString(expression, &result, &protect);
         EXPECT_FALSE(error) << error.getMessage();
         for (int i = 0; i < 4; ++i)
            EXPECT_EQ(0, raiS3cCounts[i]) << "callback " << i;
      }
      R_removeVarFromFrame(symbol, R_GlobalEnv);
   }
}

TEST(SessionRaiAssistant, DeferredEntryArgumentsNeverInvokeCallbacks)
{
   rstudio::r::sexp::Protect protect;
   SEXP result = R_NilValue;
   for (int kind : {9, 10, 11})
   {
      SEXP index = Rf_ScalarInteger(kind); protect.add(index);
      SEXP fixture = rai_s3c_fixture(index); protect.add(fixture);
      SEXP symbol = Rf_install("A_raiS3fArgument");
      Rf_defineVar(symbol, fixture, R_GlobalEnv);
      std::vector<std::string> expressions;
      if (kind != 11)
         expressions = {
            ".Call('rs_raiExpectWarning', A_raiS3fArgument, PACKAGE='(embedding)')",
            ".Call('rs_raiExpectError', A_raiS3fArgument, PACKAGE='(embedding)')"};
      else
         expressions = {
            ".Call('rs_raiObserveCondition', A_raiS3fArgument, PACKAGE='(embedding)')",
            "stopifnot(identical(.Call('rs_raiSafeObjectSummary', A_raiS3fArgument, PACKAGE='(embedding)')$summary, '<bad argument: deferred string>'))",
            "stopifnot(identical(.Call('rs_raiRealizedBindingIdentity', .GlobalEnv, A_raiS3fArgument, baseenv(), PACKAGE='(embedding)'), FALSE))",
            "stopifnot(identical(.Call('rs_raiDataObjectDetail', A_raiS3fArgument, 'full', character(), PACKAGE='(embedding)')$summary, '<bad argument: deferred string>'))",
            "stopifnot(identical(.Call('rs_raiDataObjectDetail', 'x', A_raiS3fArgument, character(), PACKAGE='(embedding)')$summary, '<bad argument: deferred string>'))",
            "stopifnot(identical(.Call('rs_raiDataObjectDetail', 'x', 'full', A_raiS3fArgument, PACKAGE='(embedding)')$summary, '<bad argument: deferred string>'))"};
      for (const auto& expression : expressions)
      {
         SCOPED_TRACE(expression);
         rai_s3c_reset();
         Error error = rstudio::r::exec::evaluateString(expression, &result, &protect);
         EXPECT_FALSE(error) << error.getMessage();
         for (int i = 0; i < 4; ++i) EXPECT_EQ(0, raiS3cCounts[i]) << "callback " << i;
      }
      R_removeVarFromFrame(symbol, R_GlobalEnv);
   }
}

TEST(SessionRaiAssistant, DeferredCallbackWitnessesDetectAccess)
{
   rstudio::r::sexp::Protect protect;
   for (int kind : {0, 2, 5})
   {
      SEXP index = Rf_ScalarInteger(kind); protect.add(index);
      SEXP value = rai_s3c_fixture(index); protect.add(value);
      SEXP deferred = kind == 0 ? Rf_getAttrib(value, R_ClassSymbol) :
                      kind == 2 ? Rf_getAttrib(value, R_DimSymbol) : value;
      rai_s3c_reset();
      EXPECT_GT(XLENGTH(deferred), 0);
      EXPECT_GT(raiS3cCounts[0], 0);
      rai_s3c_reset();
      if (kind == 0) STRING_ELT(deferred, 0);
      else if (kind == 2) INTEGER_ELT(deferred, 0);
      else VECTOR_ELT(deferred, 0);
      EXPECT_GT(raiS3cCounts[1], 0);
      rai_s3c_reset();
      DATAPTR_RO(deferred);
      EXPECT_GT(raiS3cCounts[2], 0);
      rai_s3c_reset();
      DATAPTR_OR_NULL(deferred);
      EXPECT_GT(raiS3cCounts[3], 0);
   }
}

// Live fixtures are supplied by the C1b runner in a disposable session HOME.
namespace {
void c1bRpcResult(const char* fixture, bool ready)
{
   const char* selected = std::getenv("RAI_C1B_FIXTURE");
   ASSERT_NE(nullptr, selected) << "Run with the C1b live-RPC fixture runner";
   ASSERT_EQ(std::string(fixture), std::string(selected));
   rstudio::r::sexp::Protect protect;
   SEXP result = R_NilValue;
   Error error = rstudio::r::exec::evaluateString(
      "setwd(Sys.getenv('RAI_C1B_PROJECT')); "
      ".Call('rs_invokeRpc', 'rai_get_bridge_url', list())", &result, &protect);
   ASSERT_FALSE(error) << error.asString();
   std::string status, url;
   ASSERT_FALSE(rstudio::r::sexp::getNamedListElement(result, "status", &status));
   ASSERT_FALSE(rstudio::r::sexp::getNamedListElement(result, "url", &url));
   if (ready)
   {
      EXPECT_EQ("ready", status);
      const char* expectedUrl = std::getenv("RAI_C1B_URL");
      ASSERT_NE(nullptr, expectedUrl);
      EXPECT_EQ(std::string(expectedUrl), url);
   }
   else
   {
      EXPECT_NE("ready", status);
      EXPECT_EQ("", url);
   }
}
}

TEST(SessionRaiAssistant, C1bRefresh404) { c1bRpcResult("404", false); }
TEST(SessionRaiAssistant, C1bRefresh500) { c1bRpcResult("500", false); }
TEST(SessionRaiAssistant, C1bRefreshClose) { c1bRpcResult("close", false); }
TEST(SessionRaiAssistant, C1bRefreshTimeout) { c1bRpcResult("timeout", false); }
TEST(SessionRaiAssistant, C1bRefresh401) { c1bRpcResult("401", false); }
TEST(SessionRaiAssistant, C1bRefresh403) { c1bRpcResult("403", false); }
TEST(SessionRaiAssistant, C1bTransientRetry)
{
   c1bRpcResult("retry", false);
   c1bRpcResult("retry", true);
}
TEST(SessionRaiAssistant, C1bGenuineBridge)
{
   c1bRpcResult("genuine", true);
   c1bRpcResult("genuine", true);
}
// A bare 204 cannot prove the bridge owns the session key
TEST(SessionRaiAssistant, C1bMalicious204Witness) { c1bRpcResult("204", false); }
TEST(SessionRaiAssistant, C1bNoListener)
{
   c1bRpcResult("no-listener", true);
   const char* closed = std::getenv("RAI_C1B_CLOSED");
   ASSERT_NE(nullptr, closed);
   bool stopped = false;
   for (int i = 0; i < 100; ++i)
   {
      if (FilePath(closed).exists()) { stopped = true; break; }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
   }
   ASSERT_TRUE(stopped) << "fixture listener did not close";
   c1bRpcResult("no-listener", false);
}

namespace {
void c1aCapturedBytes()
{
   const char* capture = std::getenv("RAI_C1A_CAPTURE");
   ASSERT_NE(nullptr, capture);
   std::string bytes;
   ASSERT_FALSE(rstudio::core::readStringFromFile(FilePath(capture), &bytes));
   EXPECT_EQ(std::string::npos, bytes.find("c1b-disposable-token"));
   const char* allowed = std::getenv("RAI_C1A_CWD_ALLOWED");
   if (allowed && std::string(allowed) == "0")
   {
      const char* project = std::getenv("RAI_C1B_PROJECT");
      ASSERT_NE(nullptr, project);
      EXPECT_EQ(std::string::npos, bytes.find(project));
   }
}
}
TEST(SessionRaiAssistant, C1aRejectPeer)
{
   c1bRpcResult(std::getenv("RAI_C1B_FIXTURE"), false);
   c1aCapturedBytes();
}
TEST(SessionRaiAssistant, C1aPositivePeer)
{
   c1bRpcResult(std::getenv("RAI_C1B_FIXTURE"), true);
   c1aCapturedBytes();
   c1bRpcResult(std::getenv("RAI_C1B_FIXTURE"), true);
   c1aCapturedBytes();
}
TEST(SessionRaiAssistant, C1aRetryPeer)
{
   c1bRpcResult(std::getenv("RAI_C1B_FIXTURE"), false);
   c1aCapturedBytes();
   c1bRpcResult(std::getenv("RAI_C1B_FIXTURE"), true);
   c1aCapturedBytes();
}

TEST(SessionRaiAssistant, S10CodeAllowlist)
{
   for (const std::string ext : {"r", "rmd", "qmd", "rnw", "rd", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "c", "cc", "cpp", "cxx", "h", "hh", "hpp", "f", "f90", "java", "jl", "go", "rs", "swift", "kt", "rb", "pl", "lua", "m", "stan", "cmake", "sh", "bash", "zsh", "sql", "css", "scss", "md"})
      EXPECT_EQ(RaiWriteClass::kCode, raiClassifyWritePath("src/x." + ext)) << ext;
   for (const std::string name : {"DESCRIPTION", "NAMESPACE", "Makefile", "makefile", "GNUmakefile", "Dockerfile", "CMakeLists.txt", ".Rbuildignore", ".gitignore"})
      EXPECT_EQ(RaiWriteClass::kCode, raiClassifyWritePath("src/" + name)) << name;
   EXPECT_EQ(RaiWriteClass::kUnknown, raiClassifyWritePath("src/dockerfile"));
}
TEST(SessionRaiAssistant, S10DataDenylist)
{
   for (const std::string ext : {"csv", "tsv", "tab", "psv", "txt", "dat", "rds", "rda", "rdata", "rdb", "rdx", "qs", "fst", "feather", "arrow", "ipc", "parquet", "pkl", "pickle", "joblib", "npy", "npz", "mat", "pt", "pth", "onnx", "h5", "hdf5", "h5ad", "h5seurat", "loom", "mtx", "zarr", "xlsx", "xls", "xlsm", "xlsb", "ods", "sav", "zsav", "por", "dta", "sas7bdat", "sas7bcat", "xpt", "db", "sqlite", "sqlite3", "duckdb", "mdb", "accdb", "json", "jsonl", "ndjson", "geojson", "xml", "fasta", "fa", "fna", "faa", "ffn", "frn", "fastq", "fq", "sam", "bam", "cram", "bai", "crai", "csi", "vcf", "bcf", "gvcf", "tbi", "bed", "bedgraph", "bedpe", "bigwig", "bw", "bigbed", "bb", "gtf", "gff", "gff3", "gb", "gbk", "genbank", "maf", "seg", "idat", "cel", "mzml", "mzxml", "fcs", "2bit", "fai", "dict", "chain", "wig", "narrowpeak", "broadpeak", "nii", "dcm", "svs", "ndpi", "gz", "bgz", "bz2", "xz", "zst", "zip", "tar", "tgz", "7z", "rar", "png", "jpg", "jpeg", "gif", "tif", "tiff", "pdf", "docx", "pptx"})
      EXPECT_EQ((ext == "rda" || ext == "rdata") ? RaiWriteClass::kDeniedEnv : RaiWriteClass::kDeniedData,
                raiClassifyWritePath("src/x." + ext)) << ext;
   EXPECT_EQ(RaiWriteClass::kDeniedData, raiClassifyWritePath("x.csv.R"));
   EXPECT_EQ(RaiWriteClass::kDeniedData, raiClassifyWritePath("x.csv.gz"));
   EXPECT_EQ(RaiWriteClass::kDeniedData, raiClassifyWritePath("X.CSV"));
}
TEST(SessionRaiAssistant, S10EnvironmentDenylist)
{
   for (const std::string name : {".Renviron", ".Rprofile", ".RData", ".Rhistory", ".Rapp.history", "Renviron.site", "Rprofile.site", "renv.lock", ".Renviron.site", ".envrc", ".env", ".env.local", ".netrc", ".npmrc", ".pypirc", ".pgpass", ".my.cnf", ".git-credentials", "id_rsa", "id_rsa.pub", "id_ed25519", "id_ecdsa", "foo.pem", "foo.key", "foo.p12", "foo.pfx", "foo.keystore", "foo.jks", "credentials", "credentials.json", "secrets.R", ".Rprofile.site"})
      EXPECT_EQ(RaiWriteClass::kDeniedEnv, raiClassifyWritePath("src/" + name)) << name;
   for (const std::string dir : {".git", "renv", "packrat", ".Rproj.user", ".raistudio", ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config/gcloud"})
      EXPECT_EQ(RaiWriteClass::kDeniedEnv, raiClassifyWritePath(dir + "/x.R")) << dir;
}
TEST(SessionRaiAssistant, S10DeniedDirectories)
{
   for (const std::string dir : {"data", "raw", "raw_data", "rawdata", "raw-data", "data-raw", "reference", "references", "extdata", "Raw", "REFERENCE"})
   {
      EXPECT_EQ(RaiWriteClass::kDeniedData, raiClassifyWritePath("src/" + dir + "/x.R")) << "src/" << dir << "/x.R";
      EXPECT_EQ(RaiWriteClass::kDeniedData, raiClassifyWritePath("src/" + dir + "/Makefile")) << "src/" << dir << "/Makefile";
   }
   EXPECT_EQ(RaiWriteClass::kCode, raiClassifyWritePath("refs/x.R"));
   EXPECT_EQ(RaiWriteClass::kCode, raiClassifyWritePath("ref/x.R"));
   EXPECT_EQ(RaiWriteClass::kDeniedData, raiClassifyWritePath("C:\\Data\\x.py"));
}
TEST(SessionRaiAssistant, S10UnknownPaths)
{
   for (const std::string name : {"x.yaml", "x.yml", "x.toml", "x.ini", "x.cfg", "x.conf", "x.properties", "x.html", "x.htm", "x.ipynb", "x.tex", "x.bib", "x.Rproj", "x.svg", "x.foo", "noext", ".hidden", ".hidden.R", "x.R/", "x.R.", "x.R ", "bad /x.R", "a:b.R", "..namedfork/x.R", "", "caf\xc3\xa9.R", "cafe\xcc\x81.R", "x\n.R"})
      EXPECT_EQ(RaiWriteClass::kUnknown, raiClassifyWritePath(name)) << name;
   EXPECT_EQ(RaiWriteClass::kUnknown, raiClassifyWritePath(std::string("x\0.R", 5)));
}

#endif // RAI_S3C_FIXTURE_ONLY
