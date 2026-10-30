/*
 * SessionRaiAssistant.cpp
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

// RAI Assistant launcher. Spawns the standalone rai-chat-bridge (node server.js)
// as a background child of the session and hands the client its loopback URL.
// The bridge owns the claude stream-json child; nothing Posit-specific lives
// here.

#include "SessionRaiAssistant.hpp"
#include "SessionChat.hpp"
#include "SessionSource.hpp"
#include "SessionNodeTools.hpp"
#include "rmarkdown/NotebookChunkDefs.hpp"
#include "rmarkdown/NotebookOutput.hpp"

#include <openssl/crypto.h>
#include <openssl/rand.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <csignal>
#include <cstring>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <limits>
#include <memory>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>
#include <boost/filesystem/operations.hpp>

#ifndef _WIN32
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <dirent.h>
#include <ctime>
#include <poll.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <unistd.h>
#endif

#ifdef __APPLE__
#include <libproc.h>
#include <spawn.h>
#include <sys/sysctl.h>
#endif

#include <boost/algorithm/string.hpp>
#include <boost/asio.hpp>
#include <boost/bind/bind.hpp>
#include <boost/lexical_cast.hpp>
#include <boost/regex.hpp>
#include <boost/thread/mutex.hpp>

#ifdef RSTUDIO_UNIT_TESTS_ENABLED
#include <gtest/gtest.h>
#include <boost/scope_exit.hpp>
#endif

#include <shared_core/Error.hpp>
#include <shared_core/FilePath.hpp>
#include <core/Exec.hpp>
#include <core/FileSerializer.hpp>
#include <core/StringUtils.hpp>
#include <core/http/TcpIpBlockingClient.hpp>
#include <core/http/Util.hpp>
#include <core/Log.hpp>
#include <core/system/Environment.hpp>
#include <core/system/Crypto.hpp>
#include <core/system/Process.hpp>
#include <core/system/ProcessArgs.hpp>
#include <core/system/System.hpp>

#ifndef _WIN32
#include <core/system/PosixSystem.hpp>
#endif

#include <r/RExec.hpp>
#include <r/RJson.hpp>
#include <r/ROptions.hpp>
#include <r/RRoutines.hpp>
#include <r/RRuntime.hpp>
#include <r/RSexp.hpp>
#include <r/session/RGraphics.hpp>
#include <r/session/RBusy.hpp>

#include <session/SessionConstants.hpp>
#include <session/SessionModuleContext.hpp>
#include <session/SessionOptions.hpp>
#include <session/SessionHttpConnection.hpp>
#include "../http/SessionTcpIpHttpConnectionListener.hpp"
#include <session/SessionSourceDatabase.hpp>
#include <session/projects/SessionProjects.hpp>

using namespace rstudio::core;

namespace rstudio {
namespace session {
namespace modules {
namespace rai_assistant {

namespace {

// Fallback provider/model config, mirroring config.js's DEFAULT_CONFIG. Returned
// by rai_get_settings when ~/.raistudio/assistant.json does not exist yet (the
// bridge owns actually creating the file). Kept in sync with config.js by hand.
const char* const kRaiDefaultConfigJson =
   "{\n"
   "  \"provider\": \"claude\",\n"
   "  \"model\": \"opus\",\n"
   "  \"caffeinate\": true,\n"
   "  \"saveOnEdit\": true,\n"
   "  \"autoApproveReadOnly\": true,\n"
   "  \"providers\": {\n"
   "    \"claude\": { \"command\": \"claude\", \"args\": [], \"modelFlag\": \"--model\", \"models\": [\"opus\", \"sonnet\", \"haiku\"] },\n"
   "    \"codex\": { \"command\": \"codex\", \"args\": [], \"modelFlag\": \"--model\", \"models\": [\"gpt-5.1-codex\", \"gpt-5.1-codex-mini\", \"o3\"] },\n"
   "    \"opencode\": { \"command\": \"opencode\", \"args\": [], \"modelFlag\": \"--model\", \"models\": [] },\n"
   "    \"grok\": { \"command\": \"grok\", \"args\": [], \"modelFlag\": \"--model\", \"models\": [] }\n"
   "  }\n"
   "}\n";

// Bridge process state (main thread only, mutated from RPC handlers). The
// bridge is a genuinely detached daemon (see spawnDetachedBridge() below),
// not a ProcessSupervisor-tracked child, so there are no process callbacks to
// race against here anymore.
int s_bridgePort = -1;
PidType s_bridgePid = -1;
bool s_bridgeSpawnedByThisSession = false;
std::string s_bridgeStartMarker;

bool s_spawnRequested = false;

// Crash-loop detection: without this, a bridge that dies moments after every
// spawn (e.g. Gatekeeper/quarantine blocking the bundled node binary or a
// native addon on the user's machine) respawns silently forever -- the pane
// just shows "starting" with no way for the user (or us, remotely) to tell
// why. A genuinely detached daemon can't be wait()'d on for an exit status --
// it is reparented away from us on purpose -- so death is inferred lazily,
// the next time ensureBridgeStarted() runs, from bridgeReady() plus pid
// liveness (see raiBridgeConsideredDead()) rather than pushed via a process
// callback.
std::chrono::steady_clock::time_point s_bridgeLastStartTime;
int s_bridgeRapidExitCount = 0;
std::string s_bridgeLastStderr;
const int kRaiBridgeRapidExitSecs = 5;
const int kRaiBridgeMaxRapidExits = 3;
const std::size_t kRaiBridgeStderrMaxBytes = 2000;
// How long a freshly spawned bridge gets to open its port before an
// unreachable-but-still-alive pid is treated as wedged rather than just slow
// -- generous enough for a cold Node startup under load.
const double kRaiBridgeStartupGraceSecs = 8.0;
// A live pid with an unchanged start marker is a slow start, so it keeps this longer grace.
const double kRaiBridgeLiveStartupGraceSecs = 60.0;
// Project switches and Restart R can briefly leave the prior rsession's
// stable per-window callback port bound. Never connect to that occupant: retry
// only the bind while it drains, and surface a real error after a fixed bound.
const double kRaiSessionEndpointBindRetrySecs = 12.0;
std::chrono::steady_clock::time_point s_sessionEndpointBindBusySince;

// The bridge authenticates to this owning session with the per-launch token.
// This endpoint is intentionally health/identity only; it cannot execute R.
std::string s_sessionEndpointToken;
// Non-secret identity for this rsession instance. The per-window bridge survives
// Restart R, so it uses this only to reject stale run results, never as auth.
const std::string s_sessionInstanceId = core::system::generateUuid(false);
class RaiSessionEndpointListener;
boost::shared_ptr<RaiSessionEndpointListener> s_sessionEndpointListener;

// Prefer the desktop launcher's fixed per-window port (stable across R
// session restarts) over an ephemeral one; falls back to "0" (OS-assigned)
// when no launcher supplied a port, e.g. RStudio Server.
std::string raiSessionEndpointPort()
{
   int port = session::options().raiSessionPort();
   return port > 0 ? boost::lexical_cast<std::string>(port) : "0";
}

Error handleSessionHealthRequest(const http::Request& request, http::Response* pResponse);
Error handleSettingsRequest(const http::Request& request, http::Response* pResponse);
Error handleConsoleMonitorRequest(const http::Request& request, http::Response* pResponse);

std::string peerHex(const unsigned char* bytes, std::size_t size)
{
   static const char digits[] = "0123456789abcdef";
   std::string hex;
   hex.reserve(size * 2);
   for (std::size_t i = 0; i < size; ++i)
   {
      hex += digits[bytes[i] >> 4];
      hex += digits[bytes[i] & 15];
   }
   return hex;
}

Error peerMac(const std::string& label, const std::string& nn,
              const std::string& nb, int port, const std::string& body,
              std::string* result, const std::string& method = "POST",
              const std::string& uri = "/api/workspace")
{
   std::string digest;
   Error error = core::system::crypto::sha256Hex(body, &digest);
   if (error) return error;
   std::vector<unsigned char> mac;
   error = core::system::crypto::HMAC_SHA2(
      "rai-peer-v1\n" + label + "\n" + nn + "\n" + nb +
      "\n" + method + "\n" + uri + "\n" + boost::lexical_cast<std::string>(port) + "\n" + digest,
      s_sessionEndpointToken, &mac);
   if (error) return error;
   *result = peerHex(mac.data(), mac.size());
   return Success();
}

bool peerMatches(const std::string& actual, const std::string& expected)
{
   return actual.size() == expected.size() &&
          CRYPTO_memcmp(actual.data(), expected.data(), expected.size()) == 0;
}

bool callbackAuthenticated(const http::Request&, http::Response*);
bool admitCallback(boost::shared_ptr<HttpConnection>, http::Response*);
Error handlePeerChallenge(const http::Request&, http::Response*);

class RaiSessionEndpointListener : public TcpIpHttpConnectionListener
{
public:
   RaiSessionEndpointListener()
      : TcpIpHttpConnectionListener("127.0.0.1", raiSessionEndpointPort(), "")
   {
   }

protected:
   bool authenticate(boost::shared_ptr<HttpConnection> connection) override
   {
      const http::Request& request = connection->request();
      const std::string uri = request.uri();
      // This allowlist is the outer gate: a URI missing here is rejected before
      // processSessionEndpointRequest ever dispatches it, so it must be kept in
      // step with that dispatch table.
      const bool allowed =
         (request.method() == "GET" && uri == "/health") ||
         (request.method() == "POST" &&
          (uri == "/peer_challenge" || uri == "/run" || uri == "/result" || uri == "/monitor" || uri == "/debug" || uri == "/plot" ||
           uri == "/plots" || uri == "/project_context" || uri == "/environment" ||
           uri == "/viewer" || uri == "/active_document" || uri == "/documents" || uri == "/document" ||
           uri == "/notebook_outputs" || uri == "/notebook_image" ||
           uri == "/authorize_derived" || uri == "/settings" ||
           uri == "/edit" || uri == "/file" || uri == "/write"));
      return allowed;
   }

   bool handleImmediateConnection(boost::shared_ptr<HttpConnection> connection) override
   {
      const std::string uri = connection->request().uri();
      http::Response response;
      if (uri == "/peer_challenge")
      {
         Error error = handlePeerChallenge(connection->request(), &response);
         if (error) response.setStatusCode(http::status::InternalServerError);
         response.setHeader("Cache-Control", "no-store");
         connection->sendResponse(response);
         return true;
      }
      // Consume proof before queueing; dispatch uses connection-bound admission
      if (!admitCallback(connection, &response))
      {
         if (response.statusCode() != http::status::ServiceUnavailable)
            response.setStatusCode(http::status::Unauthorized);
         connection->sendResponse(response);
         return true;
      }
      if (uri != "/health" && uri != "/monitor")
         return false;
      Error error = uri == "/health"
         ? handleSessionHealthRequest(connection->request(), &response)
         : handleConsoleMonitorRequest(connection->request(), &response);
      if (error)
         response.setStatusCode(http::status::InternalServerError);
      response.setHeader("Cache-Control", "no-store");
      connection->sendResponse(response);
      return true;
   }
};

struct CallbackChallenge
{
   std::string nc, method, uri;
   std::chrono::steady_clock::time_point expires;
};
boost::mutex s_callbackMutex;
std::map<std::string, CallbackChallenge> s_callbackChallenges;
const std::size_t kPeerBodyMaxBytes = 64 * 1024;

struct CallbackAdmission
{
   boost::weak_ptr<HttpConnection> connection;
   std::string ack;
   std::chrono::steady_clock::time_point expires;
};
std::map<const http::Request*, CallbackAdmission> s_callbackAdmissions;
#ifdef RSTUDIO_UNIT_TESTS_ENABLED
std::set<const http::Request*> s_callbackFixtureRequests;
#endif

bool verifyCallbackProof(const http::Request& request, http::Response* response)
{
   boost::mutex::scoped_lock lock(s_callbackMutex);
   const std::string nb = request.headerValue("X-RAI-Peer-Nonce");
   auto found = s_callbackChallenges.find(nb);
   if (found == s_callbackChallenges.end()) return false;
   const CallbackChallenge challenge = found->second;
   // Delete failed attempts as well as successful uses
   s_callbackChallenges.erase(found);
   std::string expected;
   const bool valid = !s_sessionEndpointToken.empty() && request.body().size() <= ((request.uri() == "/edit" || request.uri() == "/write") ? 4 * 1024 * 1024 : 4 * kPeerBodyMaxBytes) &&
      !request.containsHeader("X-RAI-Bridge-Token") &&
      challenge.expires > std::chrono::steady_clock::now() &&
      challenge.method == request.method() && challenge.uri == request.uri() &&
      !peerMac("mcp-cb-proof", challenge.nc, nb,
         (s_sessionEndpointListener ? s_sessionEndpointListener->getLocalEndpoint().port() : 0), request.body(), &expected,
         request.method(), request.uri()) &&
      peerMatches(request.headerValue("X-RAI-Peer-Proof"), expected);
   if (!valid)
   {
      s_callbackChallenges.erase(nb);
      return false;
   }
   {
      std::string ack;
      if (peerMac("native-cb-ack", challenge.nc, nb,
            (s_sessionEndpointListener ? s_sessionEndpointListener->getLocalEndpoint().port() : 0), request.body(), &ack,
            request.method(), request.uri())) return false;
      response->setHeader("X-RAI-Peer-Ack", ack);
   }
   return true;
}

// The owning listener is plain TCP; no other HTTP routes use this probe
bool callbackConnectionLive(const boost::shared_ptr<HttpConnection>& connection)
{
   auto tcp = boost::dynamic_pointer_cast<HttpConnectionImpl<boost::asio::ip::tcp>>(connection);
   if (!tcp || !tcp->socket().is_open()) return false;
   const auto fd = tcp->socket().native_handle();
#ifdef _WIN32
   fd_set readable;
   FD_ZERO(&readable);
   FD_SET(fd, &readable);
   timeval timeout = {0, 0};
   return ::select(0, &readable, nullptr, nullptr, &timeout) == 0;
#else
   pollfd readable = {fd, POLLIN, 0};
   // A finished request has no further input; EOF, errors or pipelining cancel it
   return ::poll(&readable, 1, 0) == 0;
#endif
}

#ifdef RSTUDIO_UNIT_TESTS_ENABLED
std::size_t s_callbackDispatchCount = 0;
void recordCallbackCounts()
{
   const char* root = std::getenv("RAI_C1C_FIXTURE");
   if (root)
   {
      std::size_t queued = 0;
      s_sessionEndpointListener->mainConnectionQueue().dequeMatchingConnection(
         [&queued](boost::shared_ptr<HttpConnection>, auto) { ++queued; return false; },
         std::chrono::steady_clock::now());
      core::writeStringToFile(FilePath(root).completePath("callback-counts"),
         std::to_string(s_callbackAdmissions.size()) + " " + std::to_string(s_callbackDispatchCount) + " " + std::to_string(queued));
   }
}
#endif

// Caller holds s_callbackMutex; the queue matcher takes no callback locks
void reapCallbackAdmissions()
{
   const auto now = std::chrono::steady_clock::now();
   for (auto it = s_callbackAdmissions.begin(); it != s_callbackAdmissions.end();)
   {
      auto connection = it->second.connection.lock();
      if (it->second.expires <= now || !callbackConnectionLive(connection))
      {
         if (connection)
         {
            s_sessionEndpointListener->mainConnectionQueue().dequeMatchingConnection(
               [connection](boost::shared_ptr<HttpConnection> queued, auto) { return queued == connection; }, now);
            if (callbackConnectionLive(connection))
            {
               http::Response response;
               response.setStatusCode(http::status::Unauthorized);
               connection->sendResponse(response);
            }
            else connection->close();
         }
         it = s_callbackAdmissions.erase(it);
      }
      else ++it;
   }
#ifdef RSTUDIO_UNIT_TESTS_ENABLED
   recordCallbackCounts();
#endif
}

boost::shared_ptr<boost::asio::steady_timer> s_callbackReaper;
void scheduleCallbackReaper()
{
   s_callbackReaper->expires_after(std::chrono::milliseconds(100));
   s_callbackReaper->async_wait([](const boost::system::error_code& error) {
      if (error) return;
      boost::mutex::scoped_lock lock(s_callbackMutex);
      reapCallbackAdmissions();
      if (!s_callbackAdmissions.empty()) scheduleCallbackReaper();
      else s_callbackReaper.reset();
   });
}

bool admitCallback(boost::shared_ptr<HttpConnection> connection, http::Response* response)
{
   const http::Request& request = connection->request();
   {
      boost::mutex::scoped_lock lock(s_callbackMutex);
      reapCallbackAdmissions();
   }
   if (!verifyCallbackProof(request, response)) return false;
   boost::mutex::scoped_lock lock(s_callbackMutex);
   if (s_callbackAdmissions.size() >= 16)
   {
      response->setStatusCode(http::status::ServiceUnavailable);
      return false;
   }
   s_callbackAdmissions[&request] = CallbackAdmission{connection,
      response->headerValue("X-RAI-Peer-Ack"), std::chrono::steady_clock::now() + std::chrono::seconds(30)};
   if (!s_callbackReaper)
   {
      auto tcp = boost::dynamic_pointer_cast<HttpConnectionImpl<boost::asio::ip::tcp>>(connection);
      s_callbackReaper.reset(new boost::asio::steady_timer(tcp->socket().get_executor()));
      scheduleCallbackReaper();
   }
#ifdef RSTUDIO_UNIT_TESTS_ENABLED
   recordCallbackCounts();
   const char* root = std::getenv("RAI_C1C_FIXTURE");
   if (root && FilePath(root).completePath("hold").exists())
      core::writeStringToFile(FilePath(root).completePath("admitted"), "admitted\n");
#endif
   return true;
}

bool callbackAuthenticated(const http::Request& request, http::Response* response)
{
   boost::mutex::scoped_lock lock(s_callbackMutex);
   auto found = s_callbackAdmissions.find(&request);
   if (found == s_callbackAdmissions.end())
   {
#ifdef RSTUDIO_UNIT_TESTS_ENABLED
      if (!s_callbackFixtureRequests.erase(&request)) return false;
      lock.unlock();
      return verifyCallbackProof(request, response);
#else
      return false;
#endif
   }
   const CallbackAdmission admission = found->second;
   s_callbackAdmissions.erase(found);
   auto connection = admission.connection.lock();
   if (admission.expires <= std::chrono::steady_clock::now()) return false;
   if (!callbackConnectionLive(connection) || &connection->request() != &request) return false;
#ifdef RSTUDIO_UNIT_TESTS_ENABLED
   ++s_callbackDispatchCount;
   recordCallbackCounts();
#endif
   response->setHeader("X-RAI-Peer-Ack", admission.ack);
   return true;
}

Error handlePeerChallenge(const http::Request& request, http::Response* response)
{
   {
      boost::mutex::scoped_lock lock(s_callbackMutex);
      reapCallbackAdmissions();
   }
   response->setStatusCode(http::status::Unauthorized);
   if (s_sessionEndpointToken.empty() || request.containsHeader("X-RAI-Bridge-Token") ||
       request.body().size() > kPeerBodyMaxBytes) return Success();
   json::Object input;
   std::string nc, method, uri;
   int version = 0;
   if (input.parse(request.body()) || input.getSize() != 4 ||
       json::readObject(input, "v", version, "nc", nc, "method", method, "uri", uri) ||
       version != 1 || nc.size() != 64 || nc.find_first_not_of("0123456789abcdef") != std::string::npos ||
       (method != "GET" && method != "POST") || uri.size() > 128 ||
       uri.empty() || uri[0] != '/' || uri.find_first_of("\r\n") != std::string::npos)
      return Success();
   unsigned char random[32];
   if (RAND_bytes(random, sizeof(random)) != 1) return Success();
   const std::string nb = peerHex(random, sizeof(random));
   std::string proof;
   Error error = peerMac("native-cb-proof", nc, nb,
      s_sessionEndpointListener->getLocalEndpoint().port(), "", &proof, method, uri);
   if (error) return error;
   {
      boost::mutex::scoped_lock lock(s_callbackMutex);
      const auto now = std::chrono::steady_clock::now();
      for (auto it = s_callbackChallenges.begin(); it != s_callbackChallenges.end();)
         if (it->second.expires <= now) it = s_callbackChallenges.erase(it); else ++it;
      if (s_callbackChallenges.size() >= 16)
      {
         auto oldest = std::min_element(s_callbackChallenges.begin(), s_callbackChallenges.end(),
            [](const auto& a, const auto& b) { return a.second.expires < b.second.expires; });
         s_callbackChallenges.erase(oldest);
      }
      s_callbackChallenges.emplace(nb, CallbackChallenge{nc, method, uri, now + std::chrono::seconds(5)});
   }
   json::Object answer;
   answer.insert("nb", nb);
   answer.insert("proof", proof);
   response->setStatusCode(http::status::Ok);
   response->setBody(answer.write());
   return Success();
}

// --- Native Console run capture -------------------------------------------
//
// After approval, the approved R source is entered as real Console input via
// module_context::enqueueConsoleInput -- it appears as a genuine "> <source>"
// prompt line and runs on the REPL. The result is captured from the console
// event stream rather than by evaluating the code in a wrapper:
//
//   onConsoleInput  -- correlate the queued source, then begin capturing
//   onConsoleOutput -- accumulate bounded stdout/stderr (may be off-thread)
//   onConsolePrompt -- on return to a top-level prompt, finalize the capture
//
// At most one run is ever in flight so the input/output correlation is
// unambiguous. The captured text is handed to the R run registry (the polling
// representation) via .rs.rai.recordConsoleCapture; the raw source is never
// evaluated outside the native Console.
// Reserved sits between Idle and Armed: the slot is claimed, but the run is not
// registered yet and no code is known. It exists because the R broker call in
// handleConsoleRunRequest re-enters R, and evaluating R can process events --
// which can drain another /run off this same listener queue. Claiming the slot
// up front makes "is a run in flight?" and "start one" a single step instead of
// check-then-act, so a re-entrant request cannot slip between them.
enum RaiCaptureState
{
   RaiCaptureIdle,
   RaiCaptureReserved,
   RaiCaptureArmed,
   RaiCaptureCapturing
};

// s_captureMutex guards every field in this block. onConsoleOutput may fire off
// the main thread; the other transitions are main-thread, but share the lock.
boost::mutex s_captureMutex;
std::size_t s_consoleEpoch = 0;
std::atomic<uint64_t> s_sourceRevision{0};
bool s_consoleBusy = false;
RaiCaptureState s_captureState = RaiCaptureIdle;
std::string s_captureRunId;
std::string s_captureCode;
// The text the caller submitted, which a retry is compared with; s_captureCode is the text R registered after trimming.
std::string s_captureSubmittedCode;
// Runs the native side finalized or terminalized, so /result answers them even while the Console is busy; newest last, capped.
std::vector<std::string> s_captureSettledRunIds;
int s_captureMaxLines = 0;
// Reconstructed Console-input event stream while Armed. It must remain an
// exact prefix of s_captureCode; partial matches never begin output capture.
std::string s_captureInputPrefix;
// bridge proposal id occupying the slot; identifies a
// retried request for the same proposal -- see raiInFlightRunForDigest.
std::string s_captureDigest;
std::string s_captureStdout;
std::string s_captureStderr;
// Totals stay useful after the bounded retained tails reach their caps.
std::size_t s_captureStdoutBytes = 0;
std::size_t s_captureStderrBytes = 0;
std::size_t s_captureOutputEvents = 0;
bool s_captureOutputTruncated = false;
std::chrono::steady_clock::time_point s_captureLastOutputAt;
bool s_captureHasOutput = false;
std::string s_captureCodeHash;
bool s_captureSawError = false;
std::string s_captureErrorText;
std::string s_captureExpectedError;
bool s_captureSawNonErrorCondition = false;
bool s_captureSawWarning = false;
bool s_captureUnknownStderr = false;
int s_captureKnownOutputDepth = 0;
std::vector<std::string> s_captureExpectedWarnings;
std::string s_captureUnattributedStderr;
// set when something other than the approved source reached the Console while
// this run held the slot, so the captured text may not be this run's alone
bool s_captureTainted = false;
std::string s_captureTaintReason;
std::chrono::steady_clock::time_point s_captureStartedAt;
// Whether ANY Console input event has been observed since the slot was armed,
// matching the approved source or not. This is the only local evidence that the
// input pipeline actually delivered something; a top-level prompt is NOT such
// evidence, because rConsoleRead only fires consolePrompt when R's own input
// buffer is EMPTY (SessionConsoleInput.cpp), i.e. precisely when the approved
// source has not reached R yet. See raiShouldExpireCapture.
bool s_captureSawInputSinceArm = false;

struct RaiPendingStore
{
   std::string runId;
   std::string consoleEpoch;
   double outputBytes;
   std::string conditionState;
   std::string errorText;
   std::string expectedError;
   std::vector<std::string> expectedWarnings;
   std::string unattributedStderr;
   std::string stdoutText;
   std::string stderrText;
   double elapsedMs;
   bool tainted;
   std::string taintReason;
};
std::vector<RaiPendingStore> s_pendingStores;

// per-stream in-memory cap; the R side applies the final per-run line bound
const std::size_t kRaiCaptureMaxBytes = 256 * 1024;
// Bound on one approved proposal. Generous for any single R statement, while
// keeping the endpoint from being used to shove a large payload at the Console.
const std::size_t kRaiMaxCodeBytes = 8000;
// The Console cuts a physical input line at 4094 bytes, so a longer line would run as different text than the guard analyzed.
const std::size_t kRaiMaxConsoleLineBytes = 4000;
// An Armed slot whose input never arrived is reclaimed only after this many seconds with an idle Console.
const int kRaiDiscardedInputGraceSecs = 10;

std::size_t raiUtf8CutForward(const std::string& text, std::size_t cut)
{
   for (int i = 0; i < 3 && cut < text.size() &&
                   (static_cast<unsigned char>(text[cut]) & 0xC0) == 0x80; ++i)
      ++cut;
   return cut;
}
// The MCP image payload is a base64 encoding downstream, so keep the native
// PNG strictly bounded before it crosses the authenticated loopback endpoint.
const std::uintmax_t kRaiMaxPlotImageBytes = 4 * 1024 * 1024;

void raiResetCaptureLocked()
{
   s_captureState = RaiCaptureIdle;
   s_captureRunId.clear();
   s_captureCode.clear();
   s_captureSubmittedCode.clear();
   s_captureMaxLines = 0;
   s_captureInputPrefix.clear();
   s_captureDigest.clear();
   s_captureStdout.clear();
   s_captureStderr.clear();
   s_captureStdoutBytes = 0;
   s_captureStderrBytes = 0;
   s_captureOutputEvents = 0;
   s_captureOutputTruncated = false;
   s_captureHasOutput = false;
   s_captureCodeHash.clear();
   s_captureErrorText.clear();
   s_captureExpectedError.clear();
   s_captureSawError = false;
   s_captureSawNonErrorCondition = false;
   s_captureSawWarning = false;
   s_captureUnknownStderr = false;
   s_captureKnownOutputDepth = 0;
   s_captureExpectedWarnings.clear();
   s_captureUnattributedStderr.clear();
   s_captureTainted = false;
   s_captureTaintReason.clear();
   s_captureSawInputSinceArm = false;
}

} // anonymous namespace

// The capture-slot transitions below are the module's exclusion contract, so
// they are declared in the header and exercised directly by
// SessionRaiAssistantTests.cpp. They drive process-global state rather than
// being pure, so a test must raiResetCapture() between cases.

void raiResetCapture()
{
   boost::mutex::scoped_lock lock(s_captureMutex);
   raiResetCaptureLocked();
}

// Existing bridge diagnostic tail: bounded allocation/read from one captured
// EOF. Appends may leave a stale tail; truncation/read errors return no tail.
std::string readFileTail(const FilePath& path, std::size_t maxBytes)
{
   if (maxBytes == 0 || !path.isRegularFile())
      return std::string();
   std::shared_ptr<std::istream> stream;
   if (path.openForRead(stream) || !stream)
      return std::string();
   try
   {
      stream->seekg(0, std::ios::end);
      const std::streamoff length = stream->tellg();
      if (!*stream || length <= 0)
         return std::string();
      const std::uintmax_t count = std::min<std::uintmax_t>(
         static_cast<std::uintmax_t>(length), maxBytes);
      if (count > static_cast<std::uintmax_t>(std::numeric_limits<std::streamsize>::max()))
         return std::string();
      stream->seekg(length - static_cast<std::streamoff>(count), std::ios::beg);
      if (!*stream)
         return std::string();
      std::string contents(static_cast<std::size_t>(count), '\0');
      stream->read(&contents[0], static_cast<std::streamsize>(count));
      if (!*stream || stream->gcount() != static_cast<std::streamsize>(count))
         return std::string();
      return contents;
   }
   catch (const std::ios_base::failure&)
   {
      return std::string();
   }
}

// Only an Armed slot with no input event, an idle Console and an elapsed grace period is reclaimed.
bool raiShouldExpireCapture(bool armed,
                            bool sawInputSinceArm,
                            int elapsedSecs,
                            bool consoleBusy)
{
   return armed && !sawInputSinceArm && !consoleBusy &&
          elapsedSecs >= kRaiDiscardedInputGraceSecs;
}

std::string raiConsoleRunCodeProblem(const std::string& code)
{
   std::size_t lineBytes = 0;
   for (std::string::const_iterator it = code.begin(); it != code.end(); ++it)
   {
      if (*it == '\0')
         return "run_r code contains a NUL byte";
      if (*it == '\n' || *it == '\r')
      {
         lineBytes = 0;
         continue;
      }
      if (++lineBytes > kRaiMaxConsoleLineBytes)
         return "run_r code has a line longer than " +
                boost::lexical_cast<std::string>(kRaiMaxConsoleLineBytes) +
                " bytes; split the code across shorter lines";
   }
   return std::string();
}

void raiSetConsoleBusyForTests(bool busy)
{
   boost::mutex::scoped_lock lock(s_captureMutex);
   s_consoleBusy = busy;
}

bool raiIsValidRunId(const std::string& runId)
{
   if (runId.size() <= 4 || runId.size() > 132 || runId.compare(0, 4, "run-") != 0)
      return false;

   for (std::string::const_iterator it = runId.begin() + 4; it != runId.end(); ++it)
   {
      const char ch = *it;
      if (!((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
            (ch >= '0' && ch <= '9') || ch == '-'))
         return false;
   }
   return true;
}

bool raiIsValidObjectName(const std::string& objectName)
{
   if (objectName.empty() || objectName.size() > 128)
      return false;

   const char first = objectName[0];
   if (!((first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') ||
         first == '.'))
      return false;

   for (std::string::const_iterator it = objectName.begin() + 1;
        it != objectName.end(); ++it)
   {
      const char ch = *it;
      if (!((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
            (ch >= '0' && ch <= '9') || ch == '_' || ch == '.'))
         return false;
   }
   return true;
}

bool raiIsValidSummaryMode(const std::string& summaryMode)
{
   return summaryMode == "full" || summaryMode == "nrow";
}

std::string raiProjectFileKind(const std::string& filename)
{
   const std::size_t dot = filename.find_last_of('.');
   if (dot == std::string::npos || dot + 1 == filename.size())
      return "other";

   std::string extension = filename.substr(dot + 1);
   boost::to_lower(extension);

   if (extension == "r")
      return "r_script";
   if (extension == "rmd" || extension == "qmd")
      return "r_markdown";
   if (extension == "rproj")
      return "project";
   if (extension == "csv" || extension == "tsv" || extension == "rds" ||
       extension == "rdata" || extension == "rda" || extension == "xlsx" ||
       extension == "xls" || extension == "parquet" || extension == "feather" ||
       extension == "json")
      return "data";

   return "other";
}

namespace {

// A relative path is only ever emitted when it genuinely stays under the root:
// not absolute, not rooted at a parent, and with no ".." component. A file
// merely NAMED "a..b.R" is legitimate, so this checks components rather than
// searching for the two characters anywhere in the string.
bool raiIsRootRelativePath(const std::string& relative)
{
   if (relative.empty() || relative[0] == '/' || relative == "..")
      return false;
   if (relative.compare(0, 3, "../") == 0)
      return false;
   return relative.find("/../") == std::string::npos &&
          (relative.size() < 3 || relative.compare(relative.size() - 3, 3, "/..") != 0);
}

// Depth-first, lexicographic, and hard-stopped at maxFiles. Deterministic
// ordering matters here: a truncated manifest must be a stable prefix rather
// than an arbitrary sample of the directory, so the caller can reason about
// what it did and did not see.
void raiCollectProjectFilesAtDepth(const FilePath& root,
                                   const FilePath& directory,
                                   std::size_t maxFiles,
                                   int maxDepth,
                                   int depth,
                                   std::vector<RaiProjectFileEntry>* pFiles,
                                   bool* pTruncated)
{
   if (depth > maxDepth || *pTruncated)
      return;

   std::vector<FilePath> children;
   Error error = directory.getChildren(children);
   if (error)
      return;

   std::sort(children.begin(), children.end(),
             [](const FilePath& lhs, const FilePath& rhs)
             {
                return lhs.getFilename() < rhs.getFilename();
             });

   for (const FilePath& child : children)
   {
      if (pFiles->size() >= maxFiles)
      {
         *pTruncated = true;
         return;
      }

      const std::string filename = child.getFilename();

      // Dotfiles (.Renviron, .Rhistory, .git, .ssh) are session/credential
      // surface, not project context worth advertising.
      if (filename.empty() || filename[0] == '.')
         continue;

      // A symlink is the only way this bounded, root-relative walk could still
      // reach outside the root, so it is never followed and never listed.
      if (child.isSymlink())
         continue;

      if (child.isDirectory())
      {
         // Dependency/library trees are large and are not the user's project
         // context; skipping them keeps the cap spent on real content.
         if (filename == "renv" || filename == "packrat" ||
             filename == "node_modules" || filename == "__pycache__")
            continue;

         raiCollectProjectFilesAtDepth(root, child, maxFiles, maxDepth, depth + 1,
                                       pFiles, pTruncated);
         if (*pTruncated)
            return;
         continue;
      }

      if (!child.isRegularFile())
         continue;

      RaiProjectFileEntry entry;
      entry.path = child.getRelativePath(root);
      if (!raiIsRootRelativePath(entry.path))
         continue;
      entry.kind = raiProjectFileKind(filename);
      entry.sizeBytes = child.getSize();
      pFiles->push_back(entry);
   }
}

} // anonymous namespace

void raiCollectProjectFiles(const FilePath& root,
                            std::size_t maxFiles,
                            int maxDepth,
                            std::vector<RaiProjectFileEntry>* pFiles,
                            bool* pTruncated)
{
   pFiles->clear();
   *pTruncated = false;
   if (maxFiles == 0 || maxDepth < 1 || !root.exists() || !root.isDirectory())
      return;

   raiCollectProjectFilesAtDepth(root, root, maxFiles, maxDepth, 1, pFiles, pTruncated);
}

const std::size_t kRaiMaxProjectFileBytes = 64 * 1024;
const std::size_t kRaiMaxProjectFileTotalBytes = 10 * 1024 * 1024;

// Parse canonical nonnegative decimal offsets before they reach the project
// filesystem boundary. Leading zeroes are rejected except for "0", avoiding
// ambiguous logs/cache keys; overflow fails closed.
bool raiParseProjectFileOffsetField(const std::string& value, std::size_t* pOffset)
{
   if (!pOffset || value.empty() || (value.size() > 1 && value[0] == '0'))
      return false;

   std::size_t parsed = 0;
   for (const char ch : value)
   {
      if (ch < '0' || ch > '9')
         return false;
      const std::size_t digit = static_cast<std::size_t>(ch - '0');
      if (parsed > (std::numeric_limits<std::size_t>::max() - digit) / 10)
         return false;
      parsed = parsed * 10 + digit;
   }
   *pOffset = parsed;
   return true;
}

// Wire-boundary validation for read_project_file's one required argument,
// BEFORE any FilePath is built from it. A relative path is rejected outright
// for being empty, absolute, containing a NUL byte, or containing any ".."
// component -- reusing the exact component-wise contract raiIsRootRelativePath
// already enforces for outbound /project_context entries, so the inbound and
// outbound path rules cannot drift apart. This alone does not prove the
// resolved path stays under the project root (a symlink could still escape
// after completeChildPath+getCanonicalPath); the handler re-checks that with
// FilePath::isWithin() on the canonicalized result.
bool raiIsValidProjectRelativePathArgument(const std::string& path)
{
   if (path.empty())
      return false;
   if (path.find('\0') != std::string::npos)
      return false;
   // FilePath's project-relative rule is POSIX-oriented. Reject Windows
   // drive-root syntax explicitly too, so client and native boundaries agree
   // even when the session runs on macOS/Linux.
   if (path.size() >= 3 &&
       ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) &&
       path[1] == ':' && (path[2] == '/' || path[2] == '\\'))
      return false;
   // Support the platform separator while applying the same parent/root ban to
   // either spelling. This makes the native filesystem boundary independently
   // safe on Windows as well as matching the bridge validator.
   if (path[0] == '\\' || path.compare(0, 3, "..\\") == 0 ||
       path.find("\\..\\") != std::string::npos ||
       (path.size() >= 3 && path.compare(path.size() - 3, 3, "\\..") == 0))
      return false;
   return raiIsRootRelativePath(path);
}

// Pure/testable: true only when every code point decodes as valid UTF-8 and
// contains no embedded NUL byte. A file that fails this check is refused as
// "binary" rather than truncated or replaced -- there is no bounded, safe
// subset of arbitrary bytes to return instead.
bool raiIsBoundedUtf8Text(const std::string& contents)
{
   if (contents.find('\0') != std::string::npos)
      return false;
   std::string::const_iterator pos = contents.begin();
   while (pos != contents.end())
   {
      std::string::const_iterator next;
      Error error = string_utils::utf8Advance(pos, 1, contents.end(), &next);
      if (error)
         return false;
      pos = next;
   }
   return true;
}

// Validate the entire file incrementally while retaining only one 64 KiB page
// plus a tiny UTF-8 carry/lookahead. This keeps the 10 MiB eligibility limit
// from turning into a 10 MiB per-request allocation.
// Kernel identity includes change time, so restoring bytes/mtime cannot restore
// an earlier resource revision. Unsupported platforms fail audit evidence closed.
#ifndef _WIN32
std::string raiStatRevision(const struct stat& value)
{
#ifdef __APPLE__
   const auto modified = value.st_mtimespec;
   const auto changed = value.st_ctimespec;
#else
   const auto modified = value.st_mtim;
   const auto changed = value.st_ctim;
#endif
   std::ostringstream out;
   out << value.st_dev << ':' << value.st_ino << ':' << value.st_size << ':'
       << modified.tv_sec << ':' << modified.tv_nsec << ':'
       << changed.tv_sec << ':' << changed.tv_nsec;
   return out.str();
}
#endif
std::string raiFileRevision(const FilePath& file)
{
#ifndef _WIN32
   struct stat value;
   if (::stat(file.getAbsolutePath().c_str(), &value) != 0) return std::string();
   return raiStatRevision(value);
#else
   return std::string();
#endif
}

bool raiReadProjectFilePage(const FilePath& file,
                            std::size_t fileSize,
                            std::size_t offset,
                            std::string* pPage)
{
   std::shared_ptr<std::istream> pStream;
   if (file.openForRead(pStream))
      return false;

   const std::size_t pageReadEnd = std::min(fileSize, offset + kRaiMaxProjectFileBytes + 3);
   std::string utf8Carry;
   std::string chunk(8192, '\0');
   std::size_t position = 0;
   pPage->clear();
   pPage->reserve(pageReadEnd - offset);

   while (position < fileSize)
   {
      const std::size_t wanted = std::min(chunk.size(), fileSize - position);
      pStream->read(&chunk[0], static_cast<std::streamsize>(wanted));
      const std::streamsize count = pStream->gcount();
      if (count <= 0)
         return false;

      const std::size_t bytesRead = static_cast<std::size_t>(count);
      const std::size_t chunkEnd = position + bytesRead;
      if (position < pageReadEnd && chunkEnd > offset)
      {
         const std::size_t begin = std::max(position, offset);
         const std::size_t end = std::min(chunkEnd, pageReadEnd);
         pPage->append(chunk, begin - position, end - begin);
      }

      std::string validation = utf8Carry;
      validation.append(chunk, 0, bytesRead);
      if (validation.find('\0') != std::string::npos)
         return false;

      // Keep the final three bytes (and any code point that crosses that
      // threshold) for the next read, because a UTF-8 sequence is at most four
      // bytes long. Everything before carry is now conclusively validated.
      const std::string::const_iterator cutoff = validation.cend() -
         static_cast<std::ptrdiff_t>(std::min<std::size_t>(3, validation.size()));
      std::string::const_iterator cursor = validation.cbegin();
      while (cursor < cutoff)
      {
         std::string::const_iterator next;
         if (string_utils::utf8Advance(cursor, 1, validation.cend(), &next))
            return false;
         cursor = next;
      }
      utf8Carry.assign(cursor, validation.cend());
      position = chunkEnd;
   }

   // A concurrent append would otherwise make metadata and the validation
   // surface disagree. Refuse rather than silently page a changing file.
   char extra;
   if (pStream->get(extra))
      return false;
   if (!raiIsBoundedUtf8Text(utf8Carry))
      return false;

   if (offset < fileSize && !pPage->empty() &&
       (static_cast<unsigned char>((*pPage)[0]) & 0xC0) == 0x80)
      return false;
   return true;
}

std::string raiRelativeWorkingDirectory(const FilePath& rawRoot,
                                        const FilePath& rawWorkingDir)
{
   const FilePath root(rawRoot.getCanonicalPath());
   const FilePath workingDir(rawWorkingDir.getCanonicalPath());
   if (workingDir == root)
      return ".";
   if (!workingDir.isWithin(root))
      return std::string();

   const std::string relative = workingDir.getRelativePath(root);
   if (!raiIsRootRelativePath(relative))
      return std::string();
   return relative;
}

bool raiParsePlotIndexField(const std::string& value, int* pIndex)
{
   *pIndex = -1;
   if (value.empty() || value.size() > 3)
      return false;

   for (const char ch : value)
   {
      if (ch < '0' || ch > '9')
         return false;
   }

   *pIndex = std::atoi(value.c_str());
   return true;
}

bool raiIsValidPlotIndex(int index, int plotCount)
{
   return index >= 0 && index < plotCount;
}

int raiUtf8ToUtf16CodeUnitCount(const std::string& utf8)
{
   std::size_t index = 0;
   int units = 0;
   while (index < utf8.size())
   {
      const unsigned char lead = static_cast<unsigned char>(utf8[index]);
      std::size_t width = 1;
      std::uint32_t codePoint = lead;
      if ((lead & 0xE0) == 0xC0 && index + 1 < utf8.size() &&
          (static_cast<unsigned char>(utf8[index + 1]) & 0xC0) == 0x80)
      {
         width = 2;
         codePoint = ((lead & 0x1F) << 6) |
            (static_cast<unsigned char>(utf8[index + 1]) & 0x3F);
         if (codePoint < 0x80)
            width = 1;
      }
      else if ((lead & 0xF0) == 0xE0 && index + 2 < utf8.size() &&
               (static_cast<unsigned char>(utf8[index + 1]) & 0xC0) == 0x80 &&
               (static_cast<unsigned char>(utf8[index + 2]) & 0xC0) == 0x80)
      {
         width = 3;
         codePoint = ((lead & 0x0F) << 12) |
            ((static_cast<unsigned char>(utf8[index + 1]) & 0x3F) << 6) |
            (static_cast<unsigned char>(utf8[index + 2]) & 0x3F);
         if (codePoint < 0x800 || (codePoint >= 0xD800 && codePoint <= 0xDFFF))
            width = 1;
      }
      else if ((lead & 0xF8) == 0xF0 && index + 3 < utf8.size() &&
               (static_cast<unsigned char>(utf8[index + 1]) & 0xC0) == 0x80 &&
               (static_cast<unsigned char>(utf8[index + 2]) & 0xC0) == 0x80 &&
               (static_cast<unsigned char>(utf8[index + 3]) & 0xC0) == 0x80)
      {
         width = 4;
         codePoint = ((lead & 0x07) << 18) |
            ((static_cast<unsigned char>(utf8[index + 1]) & 0x3F) << 12) |
            ((static_cast<unsigned char>(utf8[index + 2]) & 0x3F) << 6) |
            (static_cast<unsigned char>(utf8[index + 3]) & 0x3F);
         if (codePoint < 0x10000 || codePoint > 0x10FFFF)
            width = 1;
      }
      index += width;
      units += codePoint > 0xFFFF && width == 4 ? 2 : 1;
   }
   return units;
}

// Claim the single capture slot for this proposal before re-entering R. Main
// thread; returns false if a run already holds it.
bool raiReserveConsoleCapture(const std::string& digest,
                              bool requireIdleConsole,
                              bool* pConsoleBusy)
{
   boost::mutex::scoped_lock lock(s_captureMutex);
   if (pConsoleBusy)
      *pConsoleBusy = false;
   if (s_captureState != RaiCaptureIdle)
      return false;
   if (requireIdleConsole && s_consoleBusy)
   {
      if (pConsoleBusy)
         *pConsoleBusy = true;
      return false;
   }

   raiResetCaptureLocked();
   s_captureState = RaiCaptureReserved;
   s_captureDigest = digest;
   s_captureStartedAt = std::chrono::steady_clock::now();
   return true;
}

// Identity of an in-flight proposal, for collapsing a retried request onto the
// run it already created. The bridge generates this id and /run forwards it;
// R binds the same id to the exact payload before registration.
//
// Only an in-flight run is matched. Once the slot is free, an identical
// proposal is a deliberate re-run: it needs its own approval and its own run
// id, and must never be answered with a previous run's stale result.
bool raiInFlightRunForDigest(const std::string& digest, const std::string& code,
                             int maxLines, std::string* pRunId,
                             bool* pPayloadMismatch)
{
   boost::mutex::scoped_lock lock(s_captureMutex);
   pRunId->clear();
   *pPayloadMismatch = false;
   if (s_captureState == RaiCaptureIdle || digest.empty() ||
       s_captureDigest != digest)
      return false;

   // Reserved has no registered payload/run yet; it can only report busy.
   if (s_captureState == RaiCaptureReserved)
      return true;

   if (s_captureCode.empty() || s_captureMaxLines < 1 ||
       s_captureSubmittedCode != code || s_captureMaxLines != maxLines)
   {
      *pPayloadMismatch = true;
      return true;
   }
   *pRunId = s_captureRunId;
   return true;
}

const std::size_t kRaiMaxSettledRunIds = 64;

static void raiNoteSettledRunLocked(const std::string& runId)
{
   if (runId.empty() ||
       std::find(s_captureSettledRunIds.begin(), s_captureSettledRunIds.end(), runId) !=
          s_captureSettledRunIds.end())
      return;
   if (s_captureSettledRunIds.size() >= kRaiMaxSettledRunIds)
      s_captureSettledRunIds.erase(s_captureSettledRunIds.begin());
   s_captureSettledRunIds.push_back(runId);
}

void raiNoteSettledRun(const std::string& runId)
{
   boost::mutex::scoped_lock lock(s_captureMutex);
   raiNoteSettledRunLocked(runId);
}

bool raiRunResultMustWait(const std::string& runId)
{
   boost::mutex::scoped_lock lock(s_captureMutex);
   if (std::find(s_captureSettledRunIds.begin(), s_captureSettledRunIds.end(), runId) !=
       s_captureSettledRunIds.end())
      return false;
   return s_consoleBusy || s_captureState != RaiCaptureIdle;
}

// Attach the registered run to the reserved slot. Main thread.
bool raiArmConsoleCapture(const std::string& runId, const std::string& code,
                          const std::string& codeHash, int maxLines,
                          const std::string& submittedCode)
{
   boost::mutex::scoped_lock lock(s_captureMutex);
   if (s_captureState != RaiCaptureReserved || runId.empty() || code.empty() ||
       maxLines < 1 || maxLines > 1000)
      return false;

   s_captureState = RaiCaptureArmed;
   s_captureRunId = runId;
   s_captureCode = code;
   s_captureSubmittedCode = submittedCode.empty() ? code : submittedCode;
   s_captureMaxLines = maxLines;
   s_captureStdout.clear();
   s_captureStderr.clear();
   s_captureStdoutBytes = 0;
   s_captureStderrBytes = 0;
   s_captureOutputEvents = 0;
   s_captureOutputTruncated = false;
   s_captureHasOutput = false;
   s_captureCodeHash = codeHash;
   s_captureErrorText.clear();
   s_captureExpectedError.clear();
   s_captureSawError = false;
   s_captureSawNonErrorCondition = false;
   s_captureSawWarning = false;
   s_captureUnknownStderr = false;
   s_captureKnownOutputDepth = 0;
   s_captureExpectedWarnings.clear();
   s_captureUnattributedStderr.clear();
   s_captureStartedAt = std::chrono::steady_clock::now();
   // The approved source is enqueued by the caller immediately after this, so
   // the "has anything been delivered for this run yet" question restarts here.
   s_captureSawInputSinceArm = false;
   return true;
}

bool raiAcceptConsoleInput(const std::string& input)
{
   boost::mutex::scoped_lock lock(s_captureMutex);
   if (s_captureState == RaiCaptureCapturing)
   {
      if (boost::algorithm::trim_copy(input) !=
          boost::algorithm::trim_copy(s_captureCode) && !s_captureTainted)
      {
         s_captureTainted = true;
         s_captureTaintReason = "console input other than the approved source ran during capture";
      }
      return true;
   }
   if (s_captureState != RaiCaptureArmed)
      return false;

   // Something was delivered for this run, whatever it turns out to be. From
   // here the observation is diagnostic only; it does not prove that the
   // remaining approved source cannot arrive.
   s_captureSawInputSinceArm = true;

   // The Console may report the queued text as one complete event, a cumulative
   // prefix, or one physical line at a time. In every form, the reconstructed
   // stream must be an exact prefix of the approved source. This prevents a
   // shared opening token (such as "{") from capturing unrelated input.
   std::string event = input;
   boost::algorithm::replace_all(event, "\r\n", "\n");
   boost::algorithm::replace_all(event, "\r", "\n");
   std::string approved = s_captureCode;
   boost::algorithm::replace_all(approved, "\r\n", "\n");
   boost::algorithm::replace_all(approved, "\r", "\n");
   boost::algorithm::trim(approved);
   const bool wholeSource = boost::algorithm::trim_copy(event) == approved;
   std::string candidate;

   if (wholeSource)
   {
      candidate = approved;
   }
   else
   {
      candidate = s_captureInputPrefix;
      // Line-at-a-time events omit the newline separating physical lines.
      // A blank line inside the approved block produces an empty `event`
      // here; the joiner must still insert the separating newline in that
      // case, or the reconstructed prefix falls one character behind the
      // approved source forever, so completion could not be attributed.
      if (!candidate.empty() &&
          candidate.size() < approved.size() &&
          approved[candidate.size()] == '\n' &&
          (event.empty() || event.front() != '\n'))
      {
         candidate += '\n';
      }
      candidate += event;

      // A line that merely begins with the accumulated text is a cumulative resend only when the join fails.
      if ((candidate.size() > approved.size() ||
           approved.compare(0, candidate.size(), candidate) != 0) &&
          event.size() >= s_captureInputPrefix.size() &&
          event.compare(0, s_captureInputPrefix.size(), s_captureInputPrefix) == 0)
      {
         candidate = event;
      }
   }

   if (candidate.size() > approved.size() ||
       approved.compare(0, candidate.size(), candidate) != 0)
   {
      s_captureInputPrefix.clear();
      if (!s_captureTainted)
      {
         s_captureTainted = true;
         s_captureTaintReason = "unrelated console input ran before the approved source";
      }
      return false;
   }

   s_captureInputPrefix = candidate;
   if (candidate != approved)
      return false;

   s_captureState = RaiCaptureCapturing;
   s_captureStdout.clear();
   s_captureStderr.clear();
   s_captureStdoutBytes = 0;
   s_captureStderrBytes = 0;
   s_captureOutputEvents = 0;
   s_captureOutputTruncated = false;
   s_captureHasOutput = false;
   s_captureStartedAt = std::chrono::steady_clock::now();
   return true;
}

bool raiIsConsoleCaptureCapturing()
{
   boost::mutex::scoped_lock lock(s_captureMutex);
   return s_captureState == RaiCaptureCapturing;
}

void raiAppendConsoleOutputForTests(bool isError, const std::string& output)
{
   boost::mutex::scoped_lock lock(s_captureMutex);
   if (s_captureState != RaiCaptureCapturing)
      return;

   if (isError && !output.empty() && s_captureKnownOutputDepth == 0 && !s_captureSawError)
   {
      s_captureUnknownStderr = true;
      if (s_captureUnattributedStderr.size() < kRaiCaptureMaxBytes)
         s_captureUnattributedStderr.append(output, 0, raiUtf8CutForward(output, kRaiCaptureMaxBytes - s_captureUnattributedStderr.size()));
   }
   if (isError && s_captureSawError && s_captureErrorText.size() < 8000)
      s_captureErrorText.append(output, 0, raiUtf8CutForward(output, 8000 - s_captureErrorText.size()));
   std::string& buffer = isError ? s_captureStderr : s_captureStdout;
   std::size_t& total = isError ? s_captureStderrBytes : s_captureStdoutBytes;
   total += output.size();
   ++s_captureOutputEvents;
   s_captureLastOutputAt = std::chrono::steady_clock::now();
   s_captureHasOutput = true;
   if (buffer.size() >= kRaiCaptureMaxBytes)
   {
      s_captureOutputTruncated = true;
      return;
   }
   const std::size_t retained = raiUtf8CutForward(
      output, std::min(output.size(), kRaiCaptureMaxBytes - buffer.size()));
   buffer.append(output, 0, retained);
   if (retained != output.size())
      s_captureOutputTruncated = true;
}

namespace {

// Forward declared here (namespace scope, not the block-scope declaration
// previously inside raiExpireStuckCapture() below) so its linkage
// unambiguously matches this anonymous namespace's internal linkage on
// every compiler. A function declared at block scope with linkage is
// specified to behave "as if declared in the nearest enclosing namespace"
// per the standard, but this was observed to actually mismatch under MSVC
// (LNK2001/LNK1120 unresolved external for raiTerminalizeRun, Windows CI
// run 32142654687) despite compiling and linking fine under macOS clang --
// a real cross-compiler linkage-inference difference, not a portability
// no-op. Hoisting the declaration to namespace scope removes the ambiguity
// entirely rather than relying on either compiler's inference.
void raiTerminalizeRun(const std::string& runId, const std::string& message, bool executed = false);

void onRaiConsoleInput(const std::string& input)
{
   {
      boost::mutex::scoped_lock lock(s_captureMutex);
      ++s_consoleEpoch;
      s_consoleBusy = true;
   }
   raiAcceptConsoleInput(input);
}

void onRaiConsoleOutput(module_context::ConsoleOutputType type,
                        const std::string& output)
{
   // NOTE: potentially fired off the main thread; the shared helper is mutex guarded.
   raiAppendConsoleOutputForTests(type == module_context::ConsoleOutputError, output);
}

void onRaiConsolePrompt(const std::string& prompt)
{
   // Finalize only when R has returned to a top-level prompt (not a readline or
   // browser prompt raised mid-evaluation).
   if (r::session::isBusy())
      return;

   const std::string continuePrompt = r::options::getOption<std::string>("continue", std::string(), false);
   const bool isContinuation = !continuePrompt.empty() && prompt == continuePrompt;

   boost::mutex::scoped_lock lock(s_captureMutex);
   if (!isContinuation)
      s_consoleBusy = false;
   if (s_captureState != RaiCaptureCapturing)
      return;

   RaiPendingStore store;
   store.runId = s_captureRunId;
   store.consoleEpoch = boost::lexical_cast<std::string>(s_consoleEpoch);
   store.outputBytes = static_cast<double>(s_captureStdoutBytes + s_captureStderrBytes);
   store.conditionState = s_captureSawError ? "error" : s_captureUnknownStderr ? "unknown" : s_captureSawNonErrorCondition ? "non_error" : "none";
   store.errorText = s_captureErrorText;
   store.expectedError = s_captureExpectedError;
   store.expectedWarnings = s_captureExpectedWarnings;
   store.unattributedStderr = s_captureUnattributedStderr;
   store.stdoutText = s_captureStdout;
   store.stderrText = s_captureStderr;
   store.elapsedMs = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - s_captureStartedAt).count();
   store.tainted = s_captureTainted;
   store.taintReason = s_captureTaintReason;
   if (isContinuation)
   {
      const std::string waiting = "Console is waiting for more input; the statement was truncated or incomplete";
      store.conditionState = "error";
      store.errorText = waiting;
      store.expectedError.clear();
      if (!store.tainted)
      {
         store.tainted = true;
         store.taintReason = waiting;
      }
   }
   s_pendingStores.push_back(store);
   raiNoteSettledRunLocked(store.runId);
   raiResetCaptureLocked();
}

// Flush finalized captures into the R run registry. Main thread only -- called
// from onBackgroundProcessing, an established safe point for re-entering R.
void raiFlushPendingStores()
{
   std::vector<RaiPendingStore> stores;
   {
      boost::mutex::scoped_lock lock(s_captureMutex);
      if (s_pendingStores.empty())
         return;
      stores.swap(s_pendingStores);
   }

   for (const RaiPendingStore& store : stores)
   {
      Error error = r::exec::RFunction(".rs.rai.recordConsoleCapture",
                                       store.runId, store.stdoutText,
                                       store.stderrText, store.elapsedMs,
                                       store.tainted, store.taintReason, store.consoleEpoch, store.outputBytes, store.conditionState, store.errorText)
         .addParam(store.expectedWarnings)
         .addParam(store.unattributedStderr)
         .addParam(store.expectedError)
         .call();
      if (error)
      {
         LOG_ERROR(error);
         raiTerminalizeRun(store.runId, "output capture failed after the code ran: " + error.getMessage(), true);
      }
   }
}

void raiExpireStuckCapture()
{
   std::string runId;
   std::string message;
   {
      boost::mutex::scoped_lock lock(s_captureMutex);
      if (s_captureState == RaiCaptureIdle)
         return;

      const int elapsedSecs = static_cast<int>(std::chrono::duration_cast<std::chrono::seconds>(
         std::chrono::steady_clock::now() - s_captureStartedAt).count());
      if (!raiShouldExpireCapture(s_captureState == RaiCaptureArmed, s_captureSawInputSinceArm,
                                  elapsedSecs, s_consoleBusy))
         return;

      LOG_WARNING_MESSAGE("RAI approved console input was discarded; resetting capture slot");
      if (!s_captureRunId.empty())
      {
         runId = s_captureRunId;
         message = "approved input was discarded before it ran";
      }
      raiResetCaptureLocked();
   }

   // Re-enters R; must happen outside the lock (see raiFlushPendingStores).
   if (!runId.empty())
      raiTerminalizeRun(runId, message);
}

Error handleSessionHealthRequest(const http::Request& request,
                                 http::Response* pResponse)
{
   if (request.method() != "GET")
   {
      pResponse->setStatusCode(http::status::MethodNotAllowed);
      return Success();
   }

   if (!callbackAuthenticated(request, pResponse))
   {
      pResponse->setStatusCode(http::status::Unauthorized);
      return Success();
   }

   json::Object response;
   json::Array capabilities;
   capabilities.push_back("health");
   response.insert("status", "ok");
   response.insert("session_id", s_sessionInstanceId);
   {
      boost::mutex::scoped_lock lock(s_captureMutex);
      response.insert("source_revision", std::to_string(s_sourceRevision.load()));
      response.insert("console_epoch", boost::lexical_cast<std::string>(s_consoleEpoch));
      response.insert("console_busy", s_consoleBusy || s_captureState != RaiCaptureIdle);
   }
   response.insert("capabilities", capabilities);
   pResponse->setContentType("application/json");
   pResponse->setBody(response.write());
   return Success();
}

// Pull a scalar character field from the R named list directly. r::json turns
// these R scalars into one-element arrays, which is unsuitable for the run
// state machine and the MCP wire protocol.
std::string raiListField(SEXP result, const std::string& field)
{
   if (TYPEOF(result) != VECSXP)
      return std::string();

   SEXP names = Rf_getAttrib(result, R_NamesSymbol);
   if (TYPEOF(names) != STRSXP)
      return std::string();

   for (R_xlen_t i = 0; i < XLENGTH(result); ++i)
   {
      if (field != CHAR(STRING_ELT(names, i)))
         continue;
      SEXP value = VECTOR_ELT(result, i);
      if (TYPEOF(value) == STRSXP && XLENGTH(value) > 0)
         return CHAR(STRING_ELT(value, 0));
   }
   return std::string();
}

// A rejected proposal answers with a JSON body, not a bare status code: the
// caller is rai-native-mcp.js, which turns the message into the JSON-RPC error
// the assistant actually reads. http::Response::setError() would force
// text/html, so this follows the hand-rolled pattern in DataViewer.cpp.
Error raiBadRequest(http::Response* pResponse, const std::string& message)
{
   json::Object error;
   error.insert("status", "error");
   error.insert("message", message);
   pResponse->setStatusCode(http::status::BadRequest);
   pResponse->setContentType("application/json");
   pResponse->setBody(error.write());
   return Success();
}

void raiTerminalizeRun(const std::string& runId, const std::string& message, bool executed)
{
   raiNoteSettledRun(runId);
   Error error = r::exec::RFunction(".rs.rai.terminalizeRun", runId, message).addParam(executed).call();
   if (error)
      LOG_ERROR(error);
}

bool raiEnqueueRegisteredRun(const std::string& runId,
                             const std::string& code,
                             const std::string& codeHash,
                             int maxLines,
                             const std::string& proposalId,
                             bool reserved,
                             std::string* pMessage,
                             const std::string& submittedCode = std::string())
{
   if (maxLines < 1 || maxLines > 1000 || code.empty())
   {
      *pMessage = "approved console payload is missing a valid code/line binding";
      raiTerminalizeRun(runId, *pMessage);
      if (reserved)
         raiResetCapture();
      return false;
   }
   const std::string codeProblem = raiConsoleRunCodeProblem(code);
   if (!codeProblem.empty())
   {
      *pMessage = codeProblem;
      raiTerminalizeRun(runId, *pMessage);
      if (reserved)
         raiResetCapture();
      return false;
   }
   bool consoleBusy = false;
   if (!reserved && !raiReserveConsoleCapture(proposalId, true, &consoleBusy))
   {
      *pMessage = consoleBusy ? "R Console is busy; the run was not started"
                              : "another console run is already in progress";
      raiTerminalizeRun(runId, *pMessage);
      return false;
   }
   if (!raiArmConsoleCapture(runId, code, codeHash, maxLines, submittedCode))
   {
      *pMessage = "another console run is already in progress";
      raiTerminalizeRun(runId, *pMessage);
      if (reserved)
         raiResetCapture();
      return false;
   }

   Error error = module_context::enqueueConsoleInput(code);
   if (!error)
      return true;

   LOG_ERROR(error);
   *pMessage = "could not enqueue approved console input: " + error.getMessage();
   raiTerminalizeRun(runId, *pMessage);
   raiResetCapture();
   return false;
}

Error handleConsoleRunRequest(const http::Request& request,
                              http::Response* pResponse)
{
   if (request.method() != "POST")
   {
      pResponse->setStatusCode(http::status::MethodNotAllowed);
      return Success();
   }

   if (!callbackAuthenticated(request, pResponse))
   {
      pResponse->setStatusCode(http::status::Unauthorized);
      return Success();
   }

   http::Fields fields;
   http::util::parseForm(request.body(), &fields);
   std::string code = http::util::fieldValue<std::string>(fields, "code", "");
   std::string proposalId =
      http::util::fieldValue<std::string>(fields, "proposal_id", "");
   int maxLines = safe_convert::stringTo<int>(
      http::util::fieldValue<std::string>(fields, "max_lines", "200"), 200);

   // Validate the proposal as a whole before it can have any effect. The strict
   // (language, target, code) contract is enforced in rcode-distiller.js before
   // the code ever leaves the MCP process, and R owns the parse (single
   // statement, executable R); these are the bounds the native side can hold on
   // its own, so possession of the token still cannot push arbitrary bulk at
   // the Console.
   if (boost::algorithm::trim_copy(code).empty())
      return raiBadRequest(pResponse, "run_r requires executable R code");
   if (proposalId.empty() || proposalId.size() > 128)
      return raiBadRequest(pResponse, "run_r requires a valid proposal_id");
   if (code.size() > kRaiMaxCodeBytes)
      return raiBadRequest(pResponse, "run_r code exceeds " +
                           boost::lexical_cast<std::string>(kRaiMaxCodeBytes) +
                           " bytes");
   const std::string codeProblem = raiConsoleRunCodeProblem(code);
   if (!codeProblem.empty())
      return raiBadRequest(pResponse, codeProblem);
   if (maxLines < 1 || maxLines > 1000)
      return raiBadRequest(pResponse, "max_lines must be between 1 and 1000");

   // A retried request for the proposal already in flight is answered with the
   // run it already created, rather than registering a second record or
   // entering the Console input twice.
   std::string inFlightRunId;
   bool payloadMismatch = false;
   if (raiInFlightRunForDigest(proposalId, code, maxLines, &inFlightRunId, &payloadMismatch))
   {
      if (payloadMismatch)
         return raiBadRequest(pResponse, "proposal_id payload mismatch");
      json::Object retry;
      retry.insert("session_id", s_sessionInstanceId);
      if (inFlightRunId.empty())
      {
         // reserved, but the broker has not registered it yet
         retry.insert("status", "busy");
         retry.insert("message", "a console run is already in progress");
      }
      else
      {
         retry.insert("status", "queued");
         retry.insert("run_id", inFlightRunId);
      }
      pResponse->setContentType("application/json");
      pResponse->setBody(retry.write());
      return Success();
   }

   // Only one run may be in flight so the native input/output correlation is
   // unambiguous. Claim the slot before re-entering R below: evaluating R can
   // process events, which can drain another /run off this same listener queue,
   // so checking "idle" and then acting on it would not be atomic.
   bool consoleBusy = false;
   if (!raiReserveConsoleCapture(proposalId, true, &consoleBusy))
   {
      pResponse->setContentType("application/json");
      pResponse->setBody(consoleBusy
         ? "{\"status\":\"busy\",\"message\":\"R Console is busy; the run was not started\"}"
         : "{\"status\":\"busy\",\"message\":\"a console run is already in progress\"}");
      return Success();
   }

   // The R broker parses, gates (approval), and registers the run. It never
   // evaluates the code -- on "queued" the native module below enters the raw
   // approved source as real Console input and captures the result.
   r::sexp::Protect protect;
   SEXP resultSEXP = R_NilValue;
   Error error = r::exec::RFunction(".rs.rai.queueConsoleRun", proposalId, code, maxLines)
      .call(&resultSEXP, &protect);
   if (error)
   {
      raiResetCapture();
      return error;
   }

   const std::string status = raiListField(resultSEXP, "status");
   const std::string message = raiListField(resultSEXP, "message");
   const std::string runId = raiListField(resultSEXP, "run_id");
   const std::string registeredCode = raiListField(resultSEXP, "code");
   const std::string codeHash = raiListField(resultSEXP, "code_hash");
   const bool shouldEnqueue = raiListField(resultSEXP, "enqueue") == "yes";
   std::string responseStatus = status;
   std::string responseMessage = message;
   if (status == "queued" && shouldEnqueue)
   {
      int registeredMaxLines = 0;
      if (r::sexp::getNamedListElement(resultSEXP, "max_lines", &registeredMaxLines))
         registeredMaxLines = 0; // absent/malformed binding must never default
      if (!raiEnqueueRegisteredRun(runId, registeredCode, codeHash, registeredMaxLines, proposalId, true,
                                   &responseMessage, code))
         responseStatus = "error";
   }
   else
   {
      // Anything else -- awaiting approval, rejected, or a registration that
      // lost its reservation -- frees the slot. Holding it through an
      // "approval_required" would make the CLI's next retry read as busy, and
      // the run could never be approved at all.
      raiResetCapture();
   }

   json::Object response;
   response.insert("status", responseStatus);
   response.insert("session_id", s_sessionInstanceId);
   if (!responseMessage.empty())
      response.insert("message", responseMessage);
   if (!runId.empty())
      response.insert("run_id", runId);
   pResponse->setContentType("application/json");
   pResponse->setBody(response.write());
   return Success();
}

// R automatically authorizes a fresh designation after checking the normal
// binding/kind and rechecking its exact identity. Existing decisions are not
// replayed; this endpoint does not execute a proposed R program.
Error handleAuthorizeDerivedRequest(const http::Request& request,
                                    http::Response* pResponse)
{
   if (request.method() != "POST")
   {
      pResponse->setStatusCode(http::status::MethodNotAllowed);
      return Success();
   }
   if (!callbackAuthenticated(request, pResponse))
   {
      pResponse->setStatusCode(http::status::Unauthorized);
      return Success();
   }
   http::Fields fields;
   http::util::parseForm(request.body(), &fields);
   std::string name;
   std::string kind;
   bool hasName = false;
   bool hasKind = false;
   for (http::Fields::const_iterator it = fields.begin(); it != fields.end(); ++it)
   {
      if (it->first == "name" && !hasName)
      {
         name = it->second;
         hasName = true;
      }
      else if (it->first == "kind" && !hasKind)
      {
         kind = it->second;
         hasKind = true;
      }
      else
         return raiBadRequest(pResponse, "authorize_derived requires one name and kind only");
   }
   if (!hasName || !raiIsValidObjectName(name) || name.find(".rs.") == 0 ||
       !hasKind || (kind != "plots" && kind != "helper" && kind != "path"))
      return raiBadRequest(pResponse, "invalid derived binding name or kind");

   {
      boost::mutex::scoped_lock lock(s_captureMutex);
      if (s_consoleBusy || s_captureState != RaiCaptureIdle)
      {
         pResponse->setContentType("application/json");
         pResponse->setBody("{\"status\":\"busy\",\"message\":\"R Console is busy; derived authorization was not requested\"}");
         return Success();
      }
   }

   r::sexp::Protect protect;
   SEXP resultSEXP = R_NilValue;
   Error error = r::exec::RFunction(".rs.rai.authorizeDerivedBinding", name, kind)
      .call(&resultSEXP, &protect);
   if (error)
      return error;
   json::Value result;
   error = r::json::jsonValueFromList(resultSEXP, &result);
   if (error)
      return error;
   pResponse->setContentType("application/json");
   pResponse->setBody(result.write());
   return Success();
}

Error handleConsoleResultRequest(const http::Request& request,
                                 http::Response* pResponse)
{
   if (request.method() != "POST")
   {
      pResponse->setStatusCode(http::status::MethodNotAllowed);
      return Success();
   }

   if (!callbackAuthenticated(request, pResponse))
   {
      pResponse->setStatusCode(http::status::Unauthorized);
      return Success();
   }

   http::Fields fields;
   http::util::parseForm(request.body(), &fields);
   std::string runId = http::util::fieldValue<std::string>(fields, "run_id", "");
   if (!raiIsValidRunId(runId))
   {
      return raiBadRequest(pResponse, "run_id is invalid");
   }

   if (raiRunResultMustWait(runId))
   {
      json::Object pending;
      pending.insert("status", "pending");
      pending.insert("run_id", runId);
      pending.insert("session_id", s_sessionInstanceId);
      pending.insert("console_busy", true);
      pResponse->setContentType("application/json");
      pResponse->setBody(pending.write());
      return Success();
   }
   r::sexp::Protect protect;
   SEXP resultSEXP = R_NilValue;
   Error error = r::exec::RFunction(".rs.rai.getRunResult", runId)
      .call(&resultSEXP, &protect);
   if (error)
      return error;

   json::Value result;
   error = r::json::jsonValueFromList(resultSEXP, &result);
   if (error)
      return error;
   // Same scalar-as-1-element-array marshaling defect as the edit_document
   // family (see raiUnwrapSingleElementArrays' comment below): getRunResult's
   // R-side result list (status/run_id/stdout/stderr/error/approval/etc, all
   // plain un-.rs.scalar()'d strings) crosses the exact same
   // jsonValueFromList() boundary and needs the identical fix, or every
   // caller comparing e.g. result.status === 'ok' (the fake-provider fixture,
   // and any real MCP client) never matches and polls forever. Confirmed live
   // symptom: rai-console-roundtrip / rai-console-stage1-debugging-matrix
   // timing out waiting on a result file the provider never wrote because its
   // own `status === 'ok' || status === 'error'` check on the raw
   // (unwrapped) MCP response never became true.
   // .rs.rai.getRunResult defines these as scalar fields. Preserve genuinely
   // array-valued data_effects, and normalize only the trace link's named
   // scalar fields rather than flattening nested objects indiscriminately.
   raiUnwrapSingleElementArrays(&result, {"status", "run_id", "message", "approval",
                                          "stdout", "stderr", "error", "value_summary",
                                          "visible", "elapsed_ms", "completion", "console_epoch",
                                          "output_bytes", "condition_state", "native_error_text",
                                          "code_hash", "outcome_verification", "tainted",
                                          "taint_reason", "file", "seq", "queued_seq",
                                          "completed_seq"});
   if (result.isObject())
   {
      result.getObject().insert("session_id", s_sessionInstanceId);
      result.getObject().insert("console_busy", false);
   }
   pResponse->setContentType("application/json");
   pResponse->setBody(result.write());
   return Success();
}

// Read-only in-flight Console-capture snapshot. This is intentionally native:
// `/result` only becomes populated once R returns to a top-level prompt, while
// long work needs incremental output without re-entering R. The mutex-protected
// read never enqueues input, writes the run registry, or interrupts R.
Error handleConsoleMonitorRequest(const http::Request& request,
                                  http::Response* pResponse)
{
   if (request.method() != "POST")
   {
      pResponse->setStatusCode(http::status::MethodNotAllowed);
      return Success();
   }
   if (!callbackAuthenticated(request, pResponse))
   {
      pResponse->setStatusCode(http::status::Unauthorized);
      return Success();
   }

   http::Fields fields;
   http::util::parseForm(request.body(), &fields);
   if (fields.size() != 1 || fields.begin()->first != "run_id" ||
       !raiIsValidRunId(fields.begin()->second))
      return raiBadRequest(pResponse, "monitor requires exactly one valid run_id");

   const std::string runId = fields.begin()->second;
   json::Object result;
   result.insert("run_id", runId);
   result.insert("session_id", s_sessionInstanceId);
   {
      boost::mutex::scoped_lock lock(s_captureMutex);
      result.insert("console_epoch", boost::lexical_cast<std::string>(s_consoleEpoch));
      result.insert("console_busy", s_consoleBusy || s_captureState != RaiCaptureIdle);
      if (s_captureRunId != runId)
      {
         result.insert("status", "not_running");
         result.insert("state", "not_running");
      }
      else
      {
         const double elapsedMs = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - s_captureStartedAt).count();
         const std::string state = s_captureState == RaiCaptureCapturing ? "running" : "pending";
         result.insert("status", state);
         result.insert("state", state);
         result.insert("elapsed_ms", elapsedMs);
         result.insert("stdout", s_captureStdout);
         result.insert("stderr", s_captureStderr);
         result.insert("output_bytes", static_cast<double>(s_captureStdoutBytes + s_captureStderrBytes));
         result.insert("retained_output_bytes", static_cast<double>(s_captureStdout.size() + s_captureStderr.size()));
         result.insert("stdout_bytes", static_cast<double>(s_captureStdoutBytes));
         result.insert("stderr_bytes", static_cast<double>(s_captureStderrBytes));
         result.insert("output_events", static_cast<double>(s_captureOutputEvents));
         result.insert("output_truncated", s_captureOutputTruncated);
         result.insert("last_output_age_ms", s_captureHasOutput
            ? std::chrono::duration<double, std::milli>(
               std::chrono::steady_clock::now() - s_captureLastOutputAt).count()
            : -1.0);
         if (!s_captureCodeHash.empty())
            result.insert("code_hash", s_captureCodeHash);
         result.insert("tainted", s_captureTainted);
         if (s_captureTainted && !s_captureTaintReason.empty())
            result.insert("taint_reason", s_captureTaintReason);
      }
   }
   pResponse->setContentType("application/json");
   pResponse->setBody(result.write());
   return Success();
}

// get_debug_info reads one stored run plus an optional, bounded comma-separated
// list of bare R identifiers. The MCP adapter accepts an array, but identifiers
// cannot contain commas, making this form transport unambiguous. Validate every
// field here independently before R is entered.
Error handleConsoleDebugInfoRequest(const http::Request& request,
                                    http::Response* pResponse)
{
   if (request.method() != "POST")
   {
      pResponse->setStatusCode(http::status::MethodNotAllowed);
      return Success();
   }

   if (!callbackAuthenticated(request, pResponse))
   {
      pResponse->setStatusCode(http::status::Unauthorized);
      return Success();
   }

   http::Fields fields;
   http::util::parseForm(request.body(), &fields);
   const std::string runId = http::util::fieldValue<std::string>(fields, "run_id", "");
   if (!raiIsValidRunId(runId))
      return raiBadRequest(pResponse, "run_id is invalid");

   std::string objectNames;
   bool hasObjectNames = false;
   for (http::Fields::const_iterator it = fields.begin(); it != fields.end(); ++it)
   {
      if (it->first != "run_id" && it->first != "object_names")
         return raiBadRequest(pResponse, "get_debug_info contains unsupported fields");
      if (it->first == "object_names")
      {
         if (hasObjectNames)
            return raiBadRequest(pResponse, "object_names must be supplied once");
         hasObjectNames = true;
         objectNames = it->second;
      }
   }
   if (hasObjectNames)
   {
      std::vector<std::string> names;
      boost::split(names, objectNames, boost::is_any_of(","));
      if (objectNames.empty() || names.empty() || names.size() > 20)
         return raiBadRequest(pResponse, "object_names must contain 1 to 20 bare R identifiers");
      for (const std::string& name : names)
      {
         if (!raiIsValidObjectName(name))
            return raiBadRequest(pResponse, "object_names contains an invalid R identifier");
      }
   }

   r::sexp::Protect protect;
   SEXP resultSEXP = R_NilValue;
   Error error = r::exec::RFunction(".rs.rai.getDebugInfo", runId, objectNames)
      .call(&resultSEXP, &protect);
   if (error)
      return error;

   json::Value result;
   error = r::json::jsonValueFromList(resultSEXP, &result);
   if (error)
      return error;
   pResponse->setContentType("application/json");
   pResponse->setBody(result.write());
   return Success();
}

// This is deliberately not an export operation. The only files it ever reads
// are the native graphics display's own imageFilename()/imagePath() pairs: PNGs
// the RStudio Plots pane has already rendered. Its one optional body field is
// an ordinal into that same display's plot list; it never accepts a
// caller-supplied path, URL, content payload, device, or size, invokes no R
// function, and does NOT re-render or change which plot is active -- an
// unrendered history entry is reported as unavailable rather than materialized.
Error handlePlotImageRequest(const http::Request& request,
                             http::Response* pResponse)
{
   if (request.method() != "POST")
   {
      pResponse->setStatusCode(http::status::MethodNotAllowed);
      return Success();
   }

   if (!callbackAuthenticated(request, pResponse))
   {
      pResponse->setStatusCode(http::status::Unauthorized);
      return Success();
   }

   // An empty body keeps the original argument-free active-plot behavior.
   http::Fields fields;
   http::util::parseForm(request.body(), &fields);
   int requestedIndex = -1;
   if (fields.size() > 1 || (fields.size() == 1 && fields.begin()->first != "index"))
      return raiBadRequest(pResponse, "get_plot_image accepts only an optional index");
   if (fields.size() == 1 && !raiParsePlotIndexField(fields.begin()->second, &requestedIndex))
      return raiBadRequest(pResponse, "index must be a plain integer between 0 and 999");

   r::session::graphics::Display& display = r::session::graphics::display();
   if (!display.hasOutput() || display.activePlotIndex() < 0)
      return raiBadRequest(pResponse, "there is no active RStudio plot");

   std::string imageFilename;
   if (requestedIndex < 0)
   {
      imageFilename = display.imageFilename();
   }
   else
   {
      if (!raiIsValidPlotIndex(requestedIndex, display.plotCount()))
         return raiBadRequest(pResponse, "index is outside the current plot history");
      Error indexError = display.plotImageFilename(requestedIndex, &imageFilename);
      if (indexError)
         return raiBadRequest(pResponse, "index is outside the current plot history");
   }

   const FilePath imagePath = display.imagePath(imageFilename);
   if (imageFilename.empty() || !imagePath.exists() || imagePath.getSize() == 0)
   {
      // Only the plot RStudio has most recently rendered keeps a PNG on disk;
      // a superseded history entry holds a snapshot the Plots pane would have
      // to re-render. Say so instead of triggering that render.
      return raiBadRequest(pResponse, requestedIndex < 0
         ? "the active RStudio plot image is unavailable"
         : "that plot history entry has no already-rendered image; get_plot_history reports which indexes do");
   }
   if (imagePath.getSize() > kRaiMaxPlotImageBytes)
      return raiBadRequest(pResponse, "the RStudio plot image exceeds 4 MB");

   // imagePath comes exclusively from the graphics Display above, never the
   // request. This returns its current rendered PNG bytes without screenshotting
   // arbitrary UI or evaluating/enqueuing Console code.
   pResponse->setContentType("image/png");
   pResponse->setHeader("Content-Length", boost::lexical_cast<std::string>(imagePath.getSize()));
   Error error = pResponse->setBody(imagePath);
   if (error)
      return error;
   return Success();
}

const int kRaiMaxPlotHistoryEntries = 100;

// The /plots counterpart to /plot: bounded counts and per-index availability,
// no image bytes, no filenames, and no paths. It reads the same display state
// the Plots pane already shows and changes none of it -- in particular it never
// calls setActivePlot, so asking about history cannot move the user's view.
Error handlePlotHistoryRequest(const http::Request& request,
                               http::Response* pResponse)
{
   if (request.method() != "POST")
   {
      pResponse->setStatusCode(http::status::MethodNotAllowed);
      return Success();
   }

   if (!callbackAuthenticated(request, pResponse))
   {
      pResponse->setStatusCode(http::status::Unauthorized);
      return Success();
   }

   if (!request.body().empty())
      return raiBadRequest(pResponse, "get_plot_history accepts no arguments");

   r::session::graphics::Display& display = r::session::graphics::display();
   const int count = display.plotCount();
   const int activeIndex = display.activePlotIndex();
   const int reported = std::min(count, kRaiMaxPlotHistoryEntries);

   json::Array plots;
   for (int index = 0; index < reported; ++index)
   {
      std::string imageFilename;
      bool rendered = false;
      Error filenameError = display.plotImageFilename(index, &imageFilename);
      if (!filenameError && !imageFilename.empty())
      {
         const FilePath imagePath = display.imagePath(imageFilename);
         rendered = imagePath.exists() &&
                    imagePath.getSize() > 0 &&
                    imagePath.getSize() <= kRaiMaxPlotImageBytes;
      }

      json::Object entry;
      entry.insert("index", index);
      entry.insert("rendered", rendered);
      plots.push_back(entry);
   }

   json::Object result;
   result.insert("count", count);
   result.insert("active_index", (count > 0 && activeIndex >= 0)
      ? json::Value(activeIndex) : json::Value());
   result.insert("plots", plots);
   result.insert("truncated", count > reported);
   result.insert("max_plots", kRaiMaxPlotHistoryEntries);

   pResponse->setContentType("application/json");
   pResponse->setBody(result.write());
   return Success();
}

// The session's own project/working-directory context, and nothing else. There
// is no path field to parse because there is no path argument: the root is
// whatever RStudio itself already has open, so this can never be steered at an
// arbitrary directory. Everything it emits is either a bounded flag, the root's
// own bare directory NAME, or a root-relative path -- never an absolute path,
// never a parent directory, and never file contents.
Error handleProjectContextRequest(const http::Request& request,
                                  http::Response* pResponse)
{
   if (request.method() != "POST")
   {
      pResponse->setStatusCode(http::status::MethodNotAllowed);
      return Success();
   }

   if (!callbackAuthenticated(request, pResponse))
   {
      pResponse->setStatusCode(http::status::Unauthorized);
      return Success();
   }

   if (!request.body().empty())
      return raiBadRequest(pResponse, "get_project_context accepts no arguments");

   json::Object result;

   // An active RStudio project is the ONLY thing that may root this manifest.
   // There is deliberately no fallback to the session's working directory: on a
   // fresh desktop session safeCurrentPath() is the user's home directory, so a
   // fallback would ship a listing of $HOME -- and, via getFilename(), the
   // account name -- to the provider through a read-only call that raises no
   // approval card. With no project there is no bounded, user-chosen root to
   // describe, so this walks nothing and says so.
   const bool projectActive = projects::projectContext().hasProject();
   if (!projectActive)
   {
      result.insert("project_active", false);
      result.insert("root_name", json::Value());
      result.insert("working_directory", json::Value());
      pResponse->setContentType("application/json");
      pResponse->setBody(result.write());
      return Success();
   }

   const FilePath root = projects::projectContext().directory();
   const FilePath workingDir = module_context::safeCurrentPath();

   // Only the project and current-working-directory metadata already active in
   // RAI-Studio are exposed. Do not crawl, stat, or list raw project files:
   // presence on disk alone is not loaded IDE/session context.
   const std::string workingDirectory = raiRelativeWorkingDirectory(root, workingDir);

   result.insert("project_active", true);
   result.insert("root_name", root.getFilename());
   result.insert("working_directory", workingDirectory.empty()
      ? json::Value() : json::Value(workingDirectory));

   pResponse->setContentType("application/json");
   pResponse->setBody(result.write());
   return Success();
}

// Bounded read-only reflection over .GlobalEnv. Field validation here mirrors
// /debug exactly: the optional object_names list is a comma-separated set of
// bare R identifiers, each independently validated before R is entered, and no
// other field is accepted. The R broker never evaluates a caller-supplied
// expression and never forces a promise or active binding.
Error handleEnvironmentSummaryRequest(const http::Request& request,
                                      http::Response* pResponse)
{
   if (request.method() != "POST")
   {
      pResponse->setStatusCode(http::status::MethodNotAllowed);
      return Success();
   }

   if (!callbackAuthenticated(request, pResponse))
   {
      pResponse->setStatusCode(http::status::Unauthorized);
      return Success();
   }

   http::Fields fields;
   http::util::parseForm(request.body(), &fields);

   std::string objectNames;
   bool hasObjectNames = false;
   std::string summaryMode = "full";
   bool hasSummaryMode = false;
   std::string requestedColumns;
   bool hasRequestedColumns = false;
   for (http::Fields::const_iterator it = fields.begin(); it != fields.end(); ++it)
   {
      if (it->first != "object_names" && it->first != "summary_mode" &&
          it->first != "requested_columns")
         return raiBadRequest(pResponse, "get_environment_summary contains unsupported fields");
      if (it->first == "object_names")
      {
         if (hasObjectNames)
            return raiBadRequest(pResponse, "object_names must be supplied once");
         hasObjectNames = true;
         objectNames = it->second;
      }
      else if (it->first == "summary_mode")
      {
         if (hasSummaryMode)
            return raiBadRequest(pResponse, "summary_mode must be supplied once");
         hasSummaryMode = true;
         summaryMode = it->second;
      }
      else
      {
         if (hasRequestedColumns)
            return raiBadRequest(pResponse, "requested_columns must be supplied once");
         hasRequestedColumns = true;
         requestedColumns = it->second;
      }
   }
   if (hasObjectNames)
   {
      std::vector<std::string> names;
      boost::split(names, objectNames, boost::is_any_of(","));
      if (objectNames.empty() || names.empty() || names.size() > 20)
         return raiBadRequest(pResponse, "object_names must contain 1 to 20 bare R identifiers");
      for (const std::string& name : names)
      {
         if (!raiIsValidObjectName(name))
            return raiBadRequest(pResponse, "object_names contains an invalid R identifier");
      }
   }
   if (hasSummaryMode && !raiIsValidSummaryMode(summaryMode))
      return raiBadRequest(pResponse, "summary_mode must be 'full' or 'nrow'");
   if (hasRequestedColumns)
   {
      std::vector<std::string> columnNames;
      boost::split(columnNames, requestedColumns, boost::is_any_of(","));
      if (requestedColumns.empty() || columnNames.empty() || columnNames.size() > 20)
         return raiBadRequest(pResponse, "requested_columns must contain 1 to 20 bare R identifiers");
      for (const std::string& columnName : columnNames)
      {
         if (!raiIsValidObjectName(columnName))
            return raiBadRequest(pResponse, "requested_columns contains an invalid R identifier");
      }
   }

   r::sexp::Protect protect;
   SEXP resultSEXP = R_NilValue;
   Error error = r::exec::RFunction(".rs.rai.environmentSummary", objectNames,
                                    summaryMode, requestedColumns)
      .call(&resultSEXP, &protect);
   if (error)
      return error;

   json::Value result;
   error = r::json::jsonValueFromList(resultSEXP, &result);
   if (error)
      return error;
   pResponse->setContentType("application/json");
   pResponse->setBody(result.write());
   return Success();
}

const std::size_t kRaiMaxDocumentTextBytes = 64 * 1024;
const std::size_t kRaiMaxDocumentTotalBytes = 10 * 1024 * 1024;
const std::size_t kRaiMaxDocumentEditTextBytes = 32 * 1024;
const std::size_t kRaiMaxDocumentEditContextBytes = 2048;

bool raiDocumentHasProtectedPath(const boost::shared_ptr<source_database::SourceDocument>& pDoc, bool forRead = false)
{
   if (!pDoc) return true;
   const std::string path = pDoc->path();
   if (raiIsEnvironmentFilePath(path, forRead)) return true;
   if (path.empty()) return false; // unsaved ordinary R buffer
   const FilePath resolved = module_context::resolveAliasedPath(path);
   return raiIsEnvironmentFilePath(resolved.getAbsolutePath(), forRead) ||
      raiIsEnvironmentFilePath(resolved.getCanonicalPath(), forRead);
}

RaiWriteClass raiResolvedWritePathClass(const std::string& path);

bool raiIsEligibleDocument(const boost::shared_ptr<source_database::SourceDocument>& pDoc, bool forRead = false)
{
   if (!pDoc) return false;
   if (!forRead)
   {
      if (pDoc->path().empty())
         return pDoc->isRFile() || pDoc->type() == kSourceDocumentTypeRMarkdown;
      return raiResolvedWritePathClass(pDoc->path()) == RaiWriteClass::kCode;
   }
// A protected location is never readable, even when its extension makes the file write-eligible code.
   return !raiDocumentHasProtectedPath(pDoc, true) &&
      (raiIsEligibleDocument(pDoc, false) || pDoc->isRFile() || pDoc->type() == kSourceDocumentTypeRMarkdown ||
       raiDocumentHasProtectedPath(pDoc));
}

} // anonymous namespace

// Mirrors .rs.rai.protectedLocationPatterns in SessionRaiAssistant.R; keep the two lists in step.
static bool raiIsProtectedLocationPath(const std::string& path)
{
   static const char* const kPatterns[] = {
      R"((^|/)\.(ssh|aws|gnupg|kube|docker|azure|oci|kaggle|huggingface|raistudio|claude|codex|gemini|cursor|mozilla|password-store|terraform\.d|cloudflared|ngrok2|heroku|grok|openai|oh-my-zsh|zsh_sessions|bash_sessions|vim|emacs\.d)(/|$))",
      R"((^|/)\.config/(gcloud|gh|op|rclone|opencode|github-copilot|google-chrome|chromium|BraveSoftware|anthropic|fish|autostart|git|nvim|helix|zed)(/|$))",
      R"((^|/)\.local/share/(opencode|keyrings)(/|$))",
      R"((^|/)\.cache/huggingface(/|$))",
      R"((^|/)Library/(Keychains|Cookies|Safari|Mail|Messages|Accounts|LaunchAgents|LaunchDaemons)(/|$))",
      R"((^|/)Library/Application Support/(Google/Chrome|Chromium|BraveSoftware|Microsoft Edge|Firefox|Arc|Vivaldi|Opera Software|AddressBook|Claude)(/|$))",
      R"((^|/)AppData/(Local|Roaming)/(Google/Chrome|Mozilla|Microsoft/(Credentials|Protect|Vault))(/|$))",
      R"((^|/)rsconnect/accounts(/|$))",
      R"((^|/)\.git/(modules/.+/)?config$)",
      R"((^|/)\.git/(modules/.+/)?hooks(/|$))",
      R"((^|/)secrets?(/|$))",
      R"((^|/)\.R/Makevars[^/]*$)",
      R"((^|/)\.(Renviron|Rprofile|env)(\.[^/]*)?$)",
      R"((^|/)(Renviron|Rprofile)\.site$)",
      R"((^|/)\.(zshrc|zshenv|zprofile|zlogin|zlogout|bashrc|bash_profile|bash_login|bash_logout|profile|login|logout|inputrc|cshrc|tcshrc)(\.[^/]*)?$)",
      R"((^|/)\.(zshrc|zshenv|zprofile|zlogin|zlogout|bashrc|bash_profile|bash_login|profile|login)\.d(/|$))",
      R"((^|/)\.(vimrc|gvimrc|exrc|tmux\.conf|emacs|screenrc|bash_aliases|zsh_aliases)$)",
      R"((^|/)(\.envrc|\.netrc|_netrc|\.npmrc|\.pypirc|\.pgpass|\.my\.cnf|\.mylogin\.cnf|\.git-credentials|\.databrickscfg|\.vault-token|\.s3cfg|\.boto|\.claude\.json|\.gitconfig)$)",
      R"((^|/)\.[A-Za-z0-9_.]*history$)",
      R"((^|/)(credentials|secrets?)(\.[^/]*)?$)",
      R"((^|/)id_(rsa|dsa|ecdsa|ed25519)[^/]*(?<!\.pub)$)",
      R"(\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$)",
      R"(^(/private)?/etc/(passwd|master\.passwd|shadow|sudoers(\.d/.*)?)$)",
      R"(^/proc/[^/]+/environ$)"};
   static const boost::regex pattern = []() {
      std::string joined;
      for (const char* piece : kPatterns)
         joined += (joined.empty() ? "" : "|") + std::string(piece);
      return boost::regex(joined, boost::regex::perl | boost::regex::icase | boost::regex::no_mod_m);
   }();
   std::string normalized = path;
   for (char& c : normalized)
      if (c == '\\') c = '/';
   return boost::regex_search(normalized, pattern);
}

// Environment/profile/workspace files are never Assistant edit targets, even
// when open in an R-typed editor (.Rprofile opens as R source). Mirrors
// .rs.rai.isEnvironmentFile; checked natively so the refusal does not depend
// on the R broker alone.
bool raiIsEnvironmentFilePath(const std::string& path, bool forRead)
{
   std::string lowered = path;
   // ASCII-only policy names; do not invoke locale-sensitive classification
   // on an arbitrary signed UTF-8 byte.
   for (char& c : lowered)
      if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + ('a' - 'A'));
   std::size_t start = 0;
   std::string leaf;
   while (start < lowered.size())
   {
      const std::size_t end = lowered.find_first_of("/\\", start);
      const std::string component = lowered.substr(start, end == std::string::npos ? end : end - start);
      if (component == ".raistudio") return true;
      if (!component.empty()) leaf = component;
      if (end == std::string::npos) break;
      start = end + 1;
   }
   // The component scan above protects internal auth/state for both purposes.
   // Reads also refuse every protected credential, profile and system location.
   if (forRead) return raiIsProtectedLocationPath(path);
   for (const char* name : {".renviron", ".rprofile", ".rdata", ".rhistory", ".rapp.history",
                            "renviron.site", "rprofile.site", "renv.lock", ".renviron.site", ".envrc"})
      if (leaf == name) return true;
   if (leaf == ".env" || leaf.compare(0, 5, ".env.") == 0) return true;
   for (const std::string suffix : {".rdata", ".rda", ".rhistory"})
      if (leaf.size() >= suffix.size() && leaf.compare(leaf.size() - suffix.size(), suffix.size(), suffix) == 0)
         return true;
   return false;
}

// RAI write policy only. Read endpoints retain their existing eligibility.
RaiWriteClass raiClassifyWritePath(const std::string& path)
{
   if (path.empty() || path.back() == '/' || path.back() == '\\') return RaiWriteClass::kUnknown;
   std::string folded = path;
   for (char& c : folded)
   {
      const unsigned char byte = static_cast<unsigned char>(c);
      if (byte < 32 || byte >= 127) return RaiWriteClass::kUnknown;
      if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
      if (c == '\\') c = '/';
   }
   std::vector<std::string> parts;
   boost::split(parts, folded, boost::is_any_of("/"));
   for (const auto& part : parts)
      if ((!part.empty() && (part.back() == '.' || part.back() == ' ')) || part == "..namedfork")
         return RaiWriteClass::kUnknown;
   const std::string leaf = parts.back();
   if (leaf.find(':') != std::string::npos) return RaiWriteClass::kUnknown;
   static const std::set<std::string> envDirs = {".git", "renv", "packrat", ".rproj.user", ".raistudio", ".ssh", ".aws", ".gnupg", ".kube", ".docker"};
   static const std::set<std::string> dataDirs = {"data", "raw", "raw_data", "rawdata", "raw-data", "data-raw", "reference", "references", "extdata"};
   bool deniedData = false;
   for (std::size_t i = 0; i < parts.size(); ++i)
   {
      if (envDirs.count(parts[i]) || (i && parts[i-1] == ".config" && parts[i] == "gcloud"))
         return RaiWriteClass::kDeniedEnv;
      if (dataDirs.count(parts[i])) deniedData = true;
   }
   if (deniedData) return RaiWriteClass::kDeniedData;
   if (raiIsEnvironmentFilePath(path)) return RaiWriteClass::kDeniedEnv;
   static const std::set<std::string> envNames = {".netrc", ".npmrc", ".pypirc", ".pgpass", ".my.cnf", ".git-credentials", "credentials", "credentials.json", ".rprofile.site"};
   if (envNames.count(leaf) || leaf.find("id_rsa") == 0 || leaf.find("id_ed25519") == 0 ||
       leaf.find("id_ecdsa") == 0 || leaf.find("secrets.") == 0)
      return RaiWriteClass::kDeniedEnv;
   const std::string ext = leaf.substr(leaf.find_last_of('.') == std::string::npos ? leaf.size() : leaf.find_last_of('.') + 1);
   static const std::set<std::string> envExt = {"pem", "key", "p12", "pfx", "keystore", "jks"};
   if (envExt.count(ext)) return RaiWriteClass::kDeniedEnv;
   // This exact named exception precedes .txt; directory and environment denies still win.
   const std::size_t slash = path.find_last_of("/\\");
   const std::string originalLeaf = path.substr(slash == std::string::npos ? 0 : slash + 1);
   if (originalLeaf == "CMakeLists.txt") return RaiWriteClass::kCode;
   static const std::set<std::string> dataExt = {"csv", "tsv", "tab", "psv", "txt", "dat", "rds", "rda", "rdata", "rdb", "rdx", "qs", "fst", "feather", "arrow", "ipc", "parquet", "pkl", "pickle", "joblib", "npy", "npz", "mat", "pt", "pth", "onnx", "h5", "hdf5", "h5ad", "h5seurat", "loom", "mtx", "zarr", "xlsx", "xls", "xlsm", "xlsb", "ods", "sav", "zsav", "por", "dta", "sas7bdat", "sas7bcat", "xpt", "db", "sqlite", "sqlite3", "duckdb", "mdb", "accdb", "json", "jsonl", "ndjson", "geojson", "xml", "fasta", "fa", "fna", "faa", "ffn", "frn", "fastq", "fq", "sam", "bam", "cram", "bai", "crai", "csi", "vcf", "bcf", "gvcf", "tbi", "bed", "bedgraph", "bedpe", "bigwig", "bw", "bigbed", "bb", "gtf", "gff", "gff3", "gb", "gbk", "genbank", "maf", "seg", "idat", "cel", "mzml", "mzxml", "fcs", "2bit", "fai", "dict", "chain", "wig", "narrowpeak", "broadpeak", "nii", "dcm", "svs", "ndpi", "gz", "bgz", "bz2", "xz", "zst", "zip", "tar", "tgz", "7z", "rar", "png", "jpg", "jpeg", "gif", "tif", "tiff", "pdf", "docx", "pptx"};
   for (std::size_t dot = leaf.find('.'); dot != std::string::npos; dot = leaf.find('.', dot + 1))
   {
      const std::size_t next = leaf.find('.', dot + 1);
      if (dataExt.count(leaf.substr(dot + 1, next == std::string::npos ? next : next - dot - 1)))
         return RaiWriteClass::kDeniedData;
   }
   static const std::set<std::string> codeNames = {"DESCRIPTION", "NAMESPACE", "Makefile", "makefile", "GNUmakefile", "Dockerfile", "CMakeLists.txt", ".Rbuildignore", ".gitignore"};
   if (codeNames.count(originalLeaf)) return RaiWriteClass::kCode;
   if (leaf[0] == '.') return RaiWriteClass::kUnknown;
   static const std::set<std::string> codeExt = {"r", "rmd", "qmd", "rnw", "rd", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "c", "cc", "cpp", "cxx", "h", "hh", "hpp", "f", "f90", "java", "jl", "go", "rs", "swift", "kt", "rb", "pl", "lua", "m", "stan", "cmake", "sh", "bash", "zsh", "sql", "css", "scss", "md"};
   return codeExt.count(ext) ? RaiWriteClass::kCode : RaiWriteClass::kUnknown;
}

namespace {

RaiWriteClass raiResolvedWritePathClass(const std::string& path)
{
   const FilePath resolved = module_context::resolveAliasedPath(path);
   std::vector<std::string> spellings = {path, resolved.getAbsolutePath()};
#ifndef _WIN32
   struct stat info;
   if (::stat(resolved.getAbsolutePath().c_str(), &info) == 0)
   {
      if (info.st_nlink > 1 || !S_ISREG(info.st_mode)) return RaiWriteClass::kUnknown;
   }
   else if (errno != ENOENT) return RaiWriteClass::kUnknown;
   // Preserve intermediate link spellings: realpath alone can hide a data
   // directory when a second link leads back to a code directory.
   std::string expanded = resolved.getAbsolutePath();
   for (int hops = 0; ; ++hops)
   {
      if (hops == 40) return RaiWriteClass::kUnknown;
      bool followed = false;
      for (std::size_t end = 1; end <= expanded.size(); ++end)
      {
         if (end != expanded.size() && expanded[end] != '/') continue;
         const std::string prefix = expanded.substr(0, end);
         struct stat linkInfo;
         if (::lstat(prefix.c_str(), &linkInfo) != 0)
         {
            if (errno != ENOENT) return RaiWriteClass::kUnknown;
            break;
         }
         if (!S_ISLNK(linkInfo.st_mode)) continue;
         std::vector<char> bytes(65536);
         const ssize_t size = ::readlink(prefix.c_str(), bytes.data(), bytes.size());
         if (size <= 0 || static_cast<std::size_t>(size) == bytes.size()) return RaiWriteClass::kUnknown;
         const std::string target(bytes.data(), size);
         expanded = (target[0] == '/' ? target : FilePath(prefix).getParent().getAbsolutePath() + "/" + target) + expanded.substr(end);
         spellings.push_back(expanded);
         followed = true;
         break;
      }
      if (!followed) break;
   }
   // Unsaved buffers may have no disk leaf. Resolve the longest existing parent;
   // lstat distinguishes a missing component from a dangling symlink.
   FilePath parent = resolved;
   std::string tail;
   for (;;)
   {
      char* canonical = ::realpath(parent.getAbsolutePath().c_str(), nullptr);
      if (canonical)
      {
         spellings.push_back(std::string(canonical) + tail);
         ::free(canonical);
         break;
      }
      if (errno != ENOENT || ::lstat(parent.getAbsolutePath().c_str(), &info) == 0)
         return RaiWriteClass::kUnknown;
      const FilePath next = parent.getParent();
      if (next == parent) return RaiWriteClass::kUnknown;
      tail = "/" + parent.getFilename() + tail;
      parent = next;
   }
#else
   spellings.push_back(resolved.getCanonicalPath());
   // No portable link-count proof here: fail closed until the Windows writer supports it.
   return RaiWriteClass::kUnknown;
#endif
   bool unknown = false;
   bool data = false;
   for (const auto& spelling : spellings)
   {
      const RaiWriteClass kind = raiClassifyWritePath(spelling);
      if (kind == RaiWriteClass::kDeniedEnv) return kind;
      if (kind == RaiWriteClass::kDeniedData) data = true;
      if (kind == RaiWriteClass::kUnknown) unknown = true;
   }
   if (data) return RaiWriteClass::kDeniedData;
   return unknown ? RaiWriteClass::kUnknown : RaiWriteClass::kCode;
}

} // anonymous namespace

namespace {

bool raiDocumentIsEnvironmentFile(const boost::shared_ptr<source_database::SourceDocument>& pDoc)
{
   return pDoc && raiIsEnvironmentFilePath(pDoc->path());
}

bool raiDocumentIsReadOnly(const boost::shared_ptr<source_database::SourceDocument>& pDoc)
{
   if (!pDoc)
      return true;

   // SourceDocument owns the established generated/read-only classification.
   // Derive it from its metadata without exposing path or contents on this
   // endpoint, rather than inventing a second policy in the RAI module.
   json::Object metadata;
   pDoc->writeToJson(&metadata, false);
   return metadata.hasMember("read_only") && metadata["read_only"].isBool() &&
      metadata["read_only"].getBool();
}

bool raiLoadDocument(const std::string& id,
                             boost::shared_ptr<source_database::SourceDocument>* pDoc,
                             std::string* pMessage, bool forRead = false)
{
   if (id.empty() || id.size() > 256 || !boost::regex_match(id, boost::regex("^[A-Za-z0-9_-]+$")))
   {
      *pMessage = "document_id is invalid";
      return false;
   }
   std::vector<boost::shared_ptr<source_database::SourceDocument> > documents;
   Error error = source_database::list(&documents);
   if (error)
   {
      *pMessage = "could not list open source documents";
      return false;
   }
   for (const auto& document : documents)
   {
      if (document && document->id() == id && raiIsEligibleDocument(document, forRead))
      {
         *pDoc = document;
         return true;
      }
   }
   *pMessage = forRead ? "document is not an open readable .R, .Rmd or environment text document" :
      "document is not an open editable code document";
   return false;
}

Error handleOpenDocumentsRequest(const http::Request& request,
                                 http::Response* pResponse)
{
   if (request.method() != "POST") { pResponse->setStatusCode(http::status::MethodNotAllowed); return Success(); }
   if (!callbackAuthenticated(request, pResponse))
   { pResponse->setStatusCode(http::status::Unauthorized); return Success(); }
   if (!request.body().empty()) return raiBadRequest(pResponse, "list_open_documents accepts no arguments");

   std::vector<boost::shared_ptr<source_database::SourceDocument> > documents;
   Error error = source_database::list(&documents);
   if (error) return error;
   json::Array result;
   for (const auto& document : documents)
   {
      if (!raiIsEligibleDocument(document, true)) continue;
      json::Object item;
      item.insert("document_id", document->id());
      item.insert("type", document->type());
      item.insert("dirty", document->dirty());
      item.insert("read_only", raiDocumentIsReadOnly(document));
      result.push_back(item);
   }
   json::Object payload;
   payload.insert("documents", result);
   pResponse->setContentType("application/json");
   pResponse->setBody(payload.write());
   return Success();
}

Error handleActiveDocumentRequest(const http::Request& request,
                                  http::Response* pResponse)
{
   if (request.method() != "POST") { pResponse->setStatusCode(http::status::MethodNotAllowed); return Success(); }
   if (!callbackAuthenticated(request, pResponse))
   { pResponse->setStatusCode(http::status::Unauthorized); return Success(); }
   if (!request.body().empty()) return raiBadRequest(pResponse, "get_active_document_context accepts no arguments");

   const std::string id = chat::getFocusedDocumentId();
   json::Object result;
   boost::shared_ptr<source_database::SourceDocument> document;
   std::string message;
   if (id.empty() || !raiLoadDocument(id, &document, &message, true))
   {
      result.insert("active", false);
   }
   else
   {
      std::string digest;
      Error digestError = core::system::crypto::sha256Hex(document->contents(), &digest);
      if (digestError) return digestError;
      result.insert("active", true);
      result.insert("document_id", document->id());
      result.insert("type", document->type());
      result.insert("dirty", document->dirty());
      result.insert("read_only", raiDocumentIsReadOnly(document));
      result.insert("content_digest", digest);
      result.insert("total_bytes", static_cast<int>(document->contents().size()));
   }
   pResponse->setContentType("application/json");
   pResponse->setBody(result.write());
   return Success();
}

// Completed reads and in-progress page chains share one bounded LRU.

struct RaiReadToken
{
   std::string digest, revision;
   std::string diskPath, diskBytes, diskRevision;
   std::size_t next = 0;
   bool complete = false;
   uint64_t used = 0;
};
std::map<std::string, RaiReadToken> s_raiReadTokens;
uint64_t s_raiReadClock = 0;

void raiObserveRead(const std::string& key, const std::string& digest,
                    const std::string& revision, std::size_t offset,
                    std::size_t end, std::size_t total)
{
   auto found = s_raiReadTokens.find(key);
   if (offset == 0)
   {
      s_raiReadTokens.erase(key);
      if (s_raiReadTokens.size() >= 256)
      {
         auto oldest = std::min_element(s_raiReadTokens.begin(), s_raiReadTokens.end(),
            [](const std::pair<const std::string, RaiReadToken>& a,
               const std::pair<const std::string, RaiReadToken>& b) { return a.second.used < b.second.used; });
         s_raiReadTokens.erase(oldest);
      }
      RaiReadToken token; token.digest = digest; token.revision = revision;
      found = s_raiReadTokens.emplace(key, token).first;
   }
   if (found == s_raiReadTokens.end()) return;
   auto& token = found->second;
   if (token.digest != digest || token.revision != revision || token.next != offset)
   { s_raiReadTokens.erase(found); return; }
   token.next = end; token.complete = end == total; token.used = ++s_raiReadClock;
}

bool raiHasReadToken(const std::string& key, const std::string& expected,
                     const std::string& current, const std::string& revision,
                     std::string* message)
{
   auto found = s_raiReadTokens.find(key);
   if (found == s_raiReadTokens.end() || !found->second.complete)
   { *message = "read whole file first"; return false; }
   if (found->second.digest != expected || expected != current || found->second.revision != revision)
   { s_raiReadTokens.erase(found); *message = "file changed since read"; return false; }
   found->second.used = ++s_raiReadClock;
   return true;
}

#ifdef RSTUDIO_UNIT_TESTS_ENABLED
FilePath s_raiDiskTestRoot;
std::function<void()> s_raiDiskBeforeCommit;
std::function<void()> s_raiDiskBeforeOpen;
std::function<void(const std::string&)> s_raiDiskAtRename;
std::function<void()> s_raiDiskAfterRename;
std::function<void(const std::string&)> s_raiDiskBeforeRename;
#endif

FilePath raiDiskProjectRoot()
{
#ifdef RSTUDIO_UNIT_TESTS_ENABLED
   if (!s_raiDiskTestRoot.isEmpty()) return s_raiDiskTestRoot;
#endif
   return projects::projectContext().hasProject() ? projects::projectContext().directory() : FilePath();
}

#ifndef _WIN32
struct RaiDiskFd
{
   int fd;
   explicit RaiDiskFd(int value) : fd(value) {}
   ~RaiDiskFd() { if (fd >= 0) ::close(fd); }
   RaiDiskFd(const RaiDiskFd&) = delete;
   RaiDiskFd& operator=(const RaiDiskFd&) = delete;
};

// Scan only this held directory, at most 4096 entries per write. In a larger
// directory recovery is best effort; it never walks into child directories.
// flock is advisory: only our cooperative .rai-write-* writers are covered.
// Age is an additional guard, never evidence that a writer has exited.
void raiSweepDiskTemps(int directory)
{
   const int scan = ::openat(directory, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
   if (scan < 0) return;
   DIR* entries = ::fdopendir(scan);
   if (!entries) { ::close(scan); return; }
   const time_t now = ::time(nullptr);
   for (unsigned count = 0; count < 4096; ++count)
   {
      const dirent* entry = ::readdir(entries);
      if (!entry) break;
      const std::string name(entry->d_name);
      if (!boost::regex_match(name, boost::regex("^\\.rai-write-[0-9a-f]{32}$"))) continue;
      struct stat info;
      if (::fstatat(directory, name.c_str(), &info, AT_SYMLINK_NOFOLLOW) ||
          !S_ISREG(info.st_mode) || info.st_uid != ::geteuid() || info.st_nlink != 1 ||
          now == static_cast<time_t>(-1) || info.st_mtime > now || now - info.st_mtime < 86400) continue;
      RaiDiskFd candidate(::openat(directory, name.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));
      struct stat held, named;
      if (candidate.fd < 0 || ::fstat(candidate.fd, &held) ||
          !S_ISREG(held.st_mode) || held.st_uid != ::geteuid() || held.st_nlink != 1 ||
          held.st_dev != info.st_dev || held.st_ino != info.st_ino ||
          held.st_mtime > now || now - held.st_mtime < 86400 ||
          ::flock(candidate.fd, LOCK_EX | LOCK_NB)) continue;
      if (::fstatat(directory, name.c_str(), &named, AT_SYMLINK_NOFOLLOW) ||
          named.st_dev != held.st_dev || named.st_ino != held.st_ino) continue;
      ::unlinkat(directory, name.c_str(), 0);
   }
   ::closedir(entries);
}

bool raiDiskContents(int fd, std::string* contents, struct stat* info, std::size_t maxBytes = kRaiMaxProjectFileTotalBytes)
{
   if (::fstat(fd, info) || !S_ISREG(info->st_mode) || info->st_nlink != 1 ||
       info->st_size < 0 || static_cast<uint64_t>(info->st_size) > maxBytes) return false;
   contents->assign(static_cast<std::size_t>(info->st_size) + 1, '\0');
   std::size_t offset = 0;
   while (offset < contents->size())
   {
      const ssize_t count = ::pread(fd, &(*contents)[offset], contents->size() - offset, offset);
      if (count < 0 && errno == EINTR) continue;
      if (count < 0) return false;
      if (!count) break;
      offset += count;
   }
   contents->resize(offset);
   struct stat after;
   return offset == static_cast<std::size_t>(info->st_size) && raiIsBoundedUtf8Text(*contents) &&
      ::fstat(fd, &after) == 0 && raiStatRevision(*info) == raiStatRevision(after);
}
#endif

bool raiDocumentDiskSnapshot(const std::string& path, std::string* bytes, std::string* revision)
{
#ifndef _WIN32
   if (path.empty()) return false;
   RaiDiskFd file(::open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));
   struct stat info, named;
   if (file.fd < 0 || !raiDiskContents(file.fd, bytes, &info, kRaiMaxDocumentTotalBytes) ||
       ::lstat(path.c_str(), &named) || named.st_dev != info.st_dev || named.st_ino != info.st_ino)
      return false;
   *revision = raiStatRevision(info);
   return true;
#else
   return false;
#endif
}

bool raiDiskIsUnopened(const FilePath& canonical, std::string* message)
{
   std::vector<boost::shared_ptr<source_database::SourceDocument>> documents;
   if (source_database::list(&documents)) { *message = "could not list open documents"; return false; }
#ifndef _WIN32
   struct stat target;
   bool haveTarget = false;
#endif
   for (const auto& document : documents)
   {
      if (!document || document->path().empty()) continue;
      const FilePath path = module_context::resolveAliasedPath(document->path());
#ifndef _WIN32
      struct stat opened;
      if (!haveTarget)
      {
         if (::stat(canonical.getAbsolutePath().c_str(), &target))
         { *message = "could not verify open document identity"; return false; }
         haveTarget = true;
      }
      if (::stat(path.getAbsolutePath().c_str(), &opened))
      {
         if (errno == ENOENT || errno == ENOTDIR) continue;
         LOG_WARNING_MESSAGE("RAI could not stat open document " + path.getAbsolutePath() + ": " + std::strerror(errno));
         *message = "could not verify open document identity"; return false;
      }
      if (opened.st_dev == target.st_dev && opened.st_ino == target.st_ino)
      { *message = "file is open; use edit_document"; return false; }
#else
      *message = "disk writes unsupported on this platform"; return false;
#endif
   }
   return true;
}

bool raiDiskTrace(const std::string& event, const std::string& path,
                  const std::string& before, const std::string& after)
{
   bool recorded = false;
   Error error = r::exec::RFunction(".rs.rai.traceDiskWrite", event, path, before, after).call(&recorded);
   return !error && recorded;
}

Error handleWriteProjectFileRequest(const http::Request& request, http::Response* response)
{
   if (request.method() != "POST") { response->setStatusCode(http::status::MethodNotAllowed); return Success(); }
   if (!callbackAuthenticated(request, response))
   { response->setStatusCode(http::status::Unauthorized); return Success(); }
   http::Fields fields; http::util::parseForm(request.body(), &fields);
   std::map<std::string, std::string> args;
   for (const auto& field : fields)
      if ((field.first != "path" && field.first != "expected_digest" && field.first != "contents") ||
          !args.emplace(field.first, field.second).second)
         return raiBadRequest(response, "write_project_file requires path, expected_digest, contents only");
   if (args.size() != 3 || !raiIsValidProjectRelativePathArgument(args["path"]) ||
       !boost::regex_match(args["expected_digest"], boost::regex("^[a-f0-9]{64}$")))
      return raiBadRequest(response, "invalid write_project_file arguments");
   const std::string& path = args["path"];
   const std::string& contents = args["contents"];
   const FilePath root = raiDiskProjectRoot();
   if (root.isEmpty()) return raiBadRequest(response, "write_project_file requires an active project");
   FilePath resolved;
   if (root.completeChildPath(path, resolved)) return raiBadRequest(response, "path could not be resolved");
   if (raiClassifyWritePath(path) != RaiWriteClass::kCode ||
       raiResolvedWritePathClass(resolved.getAbsolutePath()) != RaiWriteClass::kCode)
      return raiBadRequest(response, "write policy refused: code files only");
   if (contents.size() > kRaiMaxProjectFileTotalBytes)
   { response->setStatusCode(413); response->setBody("code file exceeds the 10 MiB project reader limit"); return Success(); }
   if (!raiIsBoundedUtf8Text(contents)) return raiBadRequest(response, "contents must be NUL-free UTF-8");
#ifndef _WIN32
   const auto real = [](const FilePath& file) {
      char* value = ::realpath(file.getAbsolutePath().c_str(), nullptr);
      const std::string result = value ? value : ""; ::free(value); return result;
   };
   const std::string canonicalRoot = real(root), canonicalPath = real(resolved);
   if (canonicalRoot.empty() || canonicalPath.empty() || !FilePath(canonicalPath).isWithin(FilePath(canonicalRoot)))
      return raiBadRequest(response, "path must exist inside the active project");
   struct stat leaf;
   if (::lstat(resolved.getAbsolutePath().c_str(), &leaf) || !S_ISREG(leaf.st_mode) || leaf.st_nlink != 1)
      return raiBadRequest(response, "existing regular non-symlink single-link file required");
   const FilePath canonical(canonicalPath);
   std::string message;
   if (!raiDiskIsUnopened(canonical, &message)) return raiBadRequest(response, message);
   // Traverse the canonical parent from a pinned root. No component may turn
   // into a symlink while descriptors are being acquired.
   RaiDiskFd directory(::open(canonicalRoot.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
   if (directory.fd < 0) return raiBadRequest(response, "project directory could not be opened");
   const std::string relative = canonical.getParent().getRelativePath(FilePath(canonicalRoot));
   std::istringstream parts(relative); std::string part;
   while (std::getline(parts, part, '/'))
   {
      if (part.empty() || part == ".") continue;
      const int next = ::openat(directory.fd, part.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (next < 0) return raiBadRequest(response, "parent directory changed");
      ::close(directory.fd); directory.fd = next;
   }
   const std::string name = canonical.getFilename();
#ifdef RSTUDIO_UNIT_TESTS_ENABLED
   if (s_raiDiskBeforeOpen) s_raiDiskBeforeOpen();
#endif
   RaiDiskFd target(::openat(directory.fd, name.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));
   std::string current; struct stat original;
   if (target.fd < 0 || !raiDiskContents(target.fd, &current, &original) ||
       original.st_dev != leaf.st_dev || original.st_ino != leaf.st_ino)
      return raiBadRequest(response, "file identity or contents changed");
   std::string digest, nextDigest;
   if (core::system::crypto::sha256Hex(current, &digest) || core::system::crypto::sha256Hex(contents, &nextDigest))
      return raiBadRequest(response, "digest unavailable");
   const std::string key = "disk:" + canonicalPath;
   const std::string revision = raiStatRevision(original);
   if (!raiHasReadToken(key, args["expected_digest"], digest, revision, &message))
      return raiBadRequest(response, message);
   raiSweepDiskTemps(directory.fd);
   const std::string temporary = ".rai-write-" + core::system::generateUuid(false);
   // macOS O_EXLOCK takes flock atomically with creation; close releases it.
   // Keep this descriptor locked through rename, including suspended writers.
   RaiDiskFd temp(::openat(directory.fd, temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC | O_EXLOCK | O_NONBLOCK, 0600));
   if (temp.fd < 0) return raiBadRequest(response, "temporary file could not be created");
   struct Cleanup { int directory; const std::string& name; ~Cleanup() { ::unlinkat(directory, name.c_str(), 0); } } cleanup{directory.fd, temporary};
   struct stat tempInfo;
   if (::fstat(temp.fd, &tempInfo) ||
       ((tempInfo.st_uid != original.st_uid || tempInfo.st_gid != original.st_gid) &&
        ::fchown(temp.fd, original.st_uid, original.st_gid)))
      return raiBadRequest(response, "ownership could not be preserved");
   std::size_t offset = 0;
   while (offset < contents.size())
   {
      const ssize_t count = ::write(temp.fd, contents.data() + offset, contents.size() - offset);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) return raiBadRequest(response, "temporary file write failed");
      offset += count;
   }
   if (::fsync(temp.fd))
      return raiBadRequest(response, "temporary file sync or mode preservation failed");
   if (!raiDiskTrace("edit_apply_requested", path, digest, nextDigest))
      return raiBadRequest(response, "edit trace unavailable; disk write refused");
#ifdef RSTUDIO_UNIT_TESTS_ENABLED
   if (s_raiDiskBeforeCommit) s_raiDiskBeforeCommit();
#endif
   // Re-read the held file and re-open its directory entry immediately before
   // rename. An external writer can still race the final check and rename.
   RaiDiskFd finalTarget(::openat(directory.fd, name.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));
   struct stat finalInfo, heldInfo, directoryInfo, namedDirectory;
   std::string finalContents, finalDigest;
   if (finalTarget.fd < 0 || !raiDiskContents(finalTarget.fd, &finalContents, &finalInfo) ||
       ::fstat(target.fd, &heldInfo) || raiStatRevision(heldInfo) != revision ||
       raiStatRevision(finalInfo) != revision || finalInfo.st_dev != original.st_dev || finalInfo.st_ino != original.st_ino ||
       core::system::crypto::sha256Hex(finalContents, &finalDigest) || finalDigest != digest ||
       real(resolved) != canonicalPath || real(root) != canonicalRoot ||
       raiClassifyWritePath(path) != RaiWriteClass::kCode ||
       raiResolvedWritePathClass(resolved.getAbsolutePath()) != RaiWriteClass::kCode ||
       ::fstat(directory.fd, &directoryInfo) || ::stat(canonical.getParent().getAbsolutePath().c_str(), &namedDirectory) ||
       directoryInfo.st_dev != namedDirectory.st_dev || directoryInfo.st_ino != namedDirectory.st_ino ||
       !raiDiskIsUnopened(canonical, &message) ||
       !raiHasReadToken(key, args["expected_digest"], finalDigest, revision, &message))
   { s_raiReadTokens.erase(key); return raiBadRequest(response, "file changed before atomic write; read whole file again"); }
   s_raiReadTokens.erase(key);
#ifdef RSTUDIO_UNIT_TESTS_ENABLED
   if (s_raiDiskAtRename) s_raiDiskAtRename(temporary);
#endif
   struct stat namedTemp;
   if (::fstat(temp.fd, &tempInfo) || !S_ISREG(tempInfo.st_mode) || tempInfo.st_nlink != 1 ||
       tempInfo.st_size != static_cast<off_t>(contents.size()) ||
       ::fstatat(directory.fd, temporary.c_str(), &namedTemp, AT_SYMLINK_NOFOLLOW) ||
       !S_ISREG(namedTemp.st_mode) || namedTemp.st_nlink != 1 ||
       namedTemp.st_dev != tempInfo.st_dev || namedTemp.st_ino != tempInfo.st_ino ||
       namedTemp.st_size != tempInfo.st_size)
      return raiBadRequest(response, "temporary entry changed before atomic write");
   // Re-resolve the project-relative parent beside rename. Descriptor traversal
   // prevents symlink redirection, but cannot stop a directory being moved after
   // this check, even outside the project or beneath raw/. Rename has no CAS:
   // a concurrent edit can be lost and a deleted target can be recreated.
   const std::string parentNow = real(resolved.getParent());
   if (parentNow.empty() || real(root) != canonicalRoot ||
       (parentNow != canonicalRoot && !FilePath(parentNow).isWithin(FilePath(canonicalRoot))) ||
       raiResolvedWritePathClass(resolved.getAbsolutePath()) != RaiWriteClass::kCode ||
       ::fstat(directory.fd, &directoryInfo) || ::stat(parentNow.c_str(), &namedDirectory) ||
       directoryInfo.st_dev != namedDirectory.st_dev || directoryInfo.st_ino != namedDirectory.st_ino)
      return raiBadRequest(response, "parent directory changed before atomic write");
   // Keep replacement bytes private through tracing and validation. A crash in
   // the final chmod/rename window can still leave the restored target mode.
   if (::fchmod(temp.fd, original.st_mode & 07777))
      return raiBadRequest(response, "temporary mode preservation failed");
#ifdef RSTUDIO_UNIT_TESTS_ENABLED
   if (s_raiDiskBeforeRename) s_raiDiskBeforeRename(temporary);
#endif
   if (::renameat(directory.fd, temporary.c_str(), directory.fd, name.c_str()))
      return raiBadRequest(response, "atomic rename failed");
#ifdef RSTUDIO_UNIT_TESTS_ENABLED
   if (s_raiDiskAfterRename) s_raiDiskAfterRename();
#endif
   RaiDiskFd installed(::openat(directory.fd, name.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));
   struct stat written;
   std::string installedContents, installedDigest;
   if (installed.fd < 0 || !raiDiskContents(installed.fd, &installedContents, &written) ||
       written.st_dev != tempInfo.st_dev || written.st_ino != tempInfo.st_ino ||
       written.st_size != static_cast<off_t>(contents.size()) ||
       core::system::crypto::sha256Hex(installedContents, &installedDigest) || installedDigest != nextDigest ||
       ::fsync(temp.fd) || ::fsync(directory.fd) ||
       !raiDiskTrace("edit_applied", path, digest, nextDigest))
      return raiBadRequest(response, "disk write occurred; completion unverified; re-read before continuing");
   raiObserveRead(key, nextDigest, raiStatRevision(written), 0, contents.size(), contents.size());
   json::Object result; result.insert("status", "applied"); result.insert("approval", "autonomous");
   result.insert("path", path); result.insert("content_digest", nextDigest);
   result.insert("audit_revision", raiStatRevision(written));
   response->setContentType("application/json"); response->setBody(result.write()); return Success();
#else
   return raiBadRequest(response, "disk writes unsupported on this platform");
#endif
}

Error handleOpenDocumentRequest(const http::Request& request,
                                http::Response* pResponse)
{
   if (request.method() != "POST") { pResponse->setStatusCode(http::status::MethodNotAllowed); return Success(); }
   if (!callbackAuthenticated(request, pResponse))
   { pResponse->setStatusCode(http::status::Unauthorized); return Success(); }
   http::Fields fields;
   http::util::parseForm(request.body(), &fields);
   if (fields.size() < 1 || fields.size() > 3)
      return raiBadRequest(pResponse, "read_open_document requires document_id and optional offset, expected_digest");
   std::string documentId, offsetText, expectedDigest;
   bool hasDocumentId = false, hasOffset = false, hasDigest = false;
   for (const auto& field : fields)
   {
      if (field.first == "document_id" && !hasDocumentId)
      { documentId = field.second; hasDocumentId = true; }
      else if (field.first == "offset" && !hasOffset)
      { offsetText = field.second; hasOffset = true; }
      else if (field.first == "expected_digest" && !hasDigest)
      { expectedDigest = field.second; hasDigest = true; }
      else
         return raiBadRequest(pResponse, "unknown read_open_document argument");
   }
   if (!hasDocumentId)
      return raiBadRequest(pResponse, "read_open_document requires document_id");
   std::size_t offset = 0;
   if (hasOffset && !raiParseProjectFileOffsetField(offsetText, &offset))
      return raiBadRequest(pResponse, "invalid document page offset");
   if (offset > 0 && (!hasDigest || expectedDigest.size() != 64))
      return raiBadRequest(pResponse, "paged reads require the exact prior document digest");
   boost::shared_ptr<source_database::SourceDocument> document;
   std::string message;
   if (!raiLoadDocument(documentId, &document, &message, true)) return raiBadRequest(pResponse, message);
   const std::string& contents = document->contents();
   if (contents.size() > kRaiMaxDocumentTotalBytes || !raiIsBoundedUtf8Text(contents))
      return raiBadRequest(pResponse, "open document exceeds 10 MB or contains invalid text");
   std::string digest;
   Error digestError = core::system::crypto::sha256Hex(contents, &digest);
   if (digestError) return digestError;
   if (hasDigest && expectedDigest != digest)
      return raiBadRequest(pResponse, "document changed between pages");
   if (offset >= contents.size() && offset != 0)
      return raiBadRequest(pResponse, "document page offset exceeds text");
   if (offset > 0 && (static_cast<unsigned char>(contents[offset]) & 0xc0) == 0x80)
      return raiBadRequest(pResponse, "document page offset splits UTF-8 text");
   std::size_t end = std::min(contents.size(), offset + kRaiMaxDocumentTextBytes);
   while (end < contents.size() &&
          (static_cast<unsigned char>(contents[end]) & 0xc0) == 0x80)
      --end;
   if (raiIsEligibleDocument(document))
   {
      raiObserveRead("doc:" + documentId, digest, "", offset, end, contents.size());
      auto token = s_raiReadTokens.find("doc:" + documentId);
      if (offset == 0 && token != s_raiReadTokens.end() && !document->path().empty())
      {
         token->second.diskPath = module_context::resolveAliasedPath(document->path()).getAbsolutePath();
         if (!raiDocumentDiskSnapshot(token->second.diskPath, &token->second.diskBytes, &token->second.diskRevision))
            token->second.diskRevision.clear();
      }
   }
   json::Object result;
   result.insert("document_id", document->id());
   result.insert("type", document->type());
   result.insert("contents", contents.substr(offset, end - offset));
   result.insert("content_digest", digest);
   result.insert("total_bytes", static_cast<int>(contents.size()));
   result.insert("offset", static_cast<int>(offset));
   if (end < contents.size()) result.insert("next_offset", static_cast<int>(end));
   result.insert("audit_revision", std::to_string(s_sourceRevision.load()));
   pResponse->setContentType("application/json");
   pResponse->setBody(result.write());
   return Success();
}

// Read-only notebook cache inventory/image: only open R Markdown document IDs,
// registered chunk IDs and already-existing PNGs. Never replay or redraw.
Error handleNotebookOutputRequest(const http::Request& request,
                                  http::Response* pResponse, bool image)
{
   if (request.method() != "POST")
   { pResponse->setStatusCode(http::status::MethodNotAllowed); return Success(); }
   if (!callbackAuthenticated(request, pResponse))
   { pResponse->setStatusCode(http::status::Unauthorized); return Success(); }

   http::Fields fields;
   http::util::parseForm(request.body(), &fields);
   if (fields.size() != (image ? 4U : 1U))
      return raiBadRequest(pResponse, "notebook output requires an open document and bounded output identifiers");
   std::string documentId, chunkRequest, ordinalRequest, expectedDigest;
   bool hasDocumentId = false, hasChunk = false, hasOrdinal = false, hasDigest = false;
   for (const auto& field : fields)
   {
      if (field.first == "document_id" && !hasDocumentId)
      { documentId = field.second; hasDocumentId = true; }
      else if (image && field.first == "chunk_id" && !hasChunk)
      { chunkRequest = field.second; hasChunk = true; }
      else if (image && field.first == "ordinal" && !hasOrdinal)
      { ordinalRequest = field.second; hasOrdinal = true; }
      else if (image && field.first == "expected_document_digest" && !hasDigest)
      { expectedDigest = field.second; hasDigest = true; }
      else
         return raiBadRequest(pResponse, "unknown notebook output argument");
   }
   if (!hasDocumentId || (image && (!hasChunk || !hasOrdinal || !hasDigest)))
      return raiBadRequest(pResponse, "notebook output identifiers are incomplete");
   if (image && (!boost::regex_match(chunkRequest, boost::regex("^[A-Za-z0-9_-]{1,128}$")) ||
                 !boost::regex_match(ordinalRequest, boost::regex("^[a-f0-9]{6}$")) ||
                 !boost::regex_match(expectedDigest, boost::regex("^[a-f0-9]{64}$"))))
      return raiBadRequest(pResponse, "invalid notebook output identifier");

   boost::shared_ptr<source_database::SourceDocument> document;
   std::string message;
   if (!raiLoadDocument(documentId, &document, &message, true))
      return raiBadRequest(pResponse, message);
   if (document->type() != kSourceDocumentTypeRMarkdown)
      return raiBadRequest(pResponse, "notebook output requires an open R Markdown document");
   if (document->contents().size() > kRaiMaxDocumentTotalBytes)
      return raiBadRequest(pResponse, "notebook document exceeds bounded source identity");
   std::string contentDigest;
   Error digestError = core::system::crypto::sha256Hex(document->contents(), &contentDigest);
   if (digestError) return digestError;
   if (image && contentDigest != expectedDigest)
      return raiBadRequest(pResponse, "open document changed since notebook inventory; refresh before reading cached image");
   const FilePath cacheRoot = document->path().empty()
      ? module_context::sessionScratchPath().completeChildPath("unsaved-notebooks")
      : rmarkdown::notebook::notebookCacheRoot();
   json::Object values;
   Error error = rmarkdown::notebook::getChunkValues(document->path(), document->id(), &values);
   if (error) return raiBadRequest(pResponse, "notebook chunk definitions unavailable");
   json::Array definitions;
   if (values.hasMember(kChunkDefs))
   {
      error = json::readObject(values, kChunkDefs, definitions);
      if (error) return raiBadRequest(pResponse, "invalid notebook chunk definitions");
   }
   if (definitions.getSize() > 512) return raiBadRequest(pResponse, "notebook chunk inventory exceeds bound");

   json::Array outputs;
   std::size_t total = 0;
   for (const auto& value : definitions)
   {
      if (!value.isObject()) continue;
      const json::Object definition = value.getObject();
      std::string chunkId;
      if (!definition.hasMember(kChunkId) || json::readObject(definition, kChunkId, chunkId)) continue;
      if (!boost::regex_match(chunkId, boost::regex("^[A-Za-z0-9_-]{1,128}$"))) continue;
      if (image && chunkId != chunkRequest) continue;
      const FilePath folder = rmarkdown::notebook::chunkOutputPath(
         document->path(), document->id(), chunkId,
         rmarkdown::notebook::notebookCtxId(), rmarkdown::notebook::ContextSaved);
      if (!folder.exists() || !folder.isDirectory()) continue;
      const FilePath canonicalRoot(cacheRoot.getCanonicalPath());
      const FilePath canonicalFolder(folder.getCanonicalPath());
      if (!canonicalFolder.isWithin(canonicalRoot)) continue;
      std::vector<FilePath> children;
      error = folder.getChildren(children);
      if (error || children.size() > 1024)
         return raiBadRequest(pResponse, "notebook cache inventory unavailable or exceeds bound");
      std::sort(children.begin(), children.end());
      for (const FilePath& entry : children)
      {
         const std::string name = entry.getFilename();
         if (!boost::regex_match(name, boost::regex("^[a-f0-9]{6}\\.png$"))) continue;
         if (entry.isDirectory() || !FilePath(entry.getCanonicalPath()).isWithin(canonicalRoot)) continue;
         const std::uintmax_t size = entry.getSize();
         if (size == 0 || size > kRaiMaxPlotImageBytes) continue;
         const std::string ordinal = name.substr(0, 6);
         if (image && ordinal == ordinalRequest)
         {
            std::ifstream input(entry.getAbsolutePath(), std::ios::binary);
            std::string bytes(static_cast<std::size_t>(size), '\0');
            input.read(&bytes[0], static_cast<std::streamsize>(size));
            static const std::string pngSignature("\x89PNG\r\n\x1a\n", 8);
            if (!input || bytes.compare(0, 8, pngSignature) != 0)
               return raiBadRequest(pResponse, "notebook image is missing or corrupt");
            pResponse->setContentType("image/png");
            pResponse->setBody(bytes);
            return Success();
         }
         if (!image)
         {
            ++total;
            if (outputs.getSize() < 250)
            {
               json::Object item;
               item.insert("chunk_id", chunkId);
               item.insert("ordinal", ordinal);
               item.insert("bytes", static_cast<int>(size));
               item.insert("provenance", "notebook_cache_unverified_source");
               outputs.push_back(item);
            }
         }
      }
   }
   if (image) return raiBadRequest(pResponse, "notebook image unavailable");
   json::Object result;
   result.insert("document_id", document->id());
   result.insert("dirty", document->dirty());
   result.insert("content_digest", contentDigest);
   result.insert("audit_revision", std::to_string(s_sourceRevision.load()));
   result.insert("outputs", outputs);
   result.insert("total_count", static_cast<int>(total));
   result.insert("truncated", total > outputs.getSize());
   result.insert("provenance", "cached_output_only_not_current_run_proof");
   result.insert("execution_origin", "historical_notebook_cache_not_console_run");
   pResponse->setContentType("application/json");
   pResponse->setBody(result.write());
   return Success();
}

int raiCountFenceOccurrences(const std::string& text)
{
   int count = 0;
   std::size_t pos = 0;
   while ((pos = text.find("```", pos)) != std::string::npos)
   {
      ++count;
      pos += 3;
   }
   return count;
}

// Extracts the inner text of every ```{r ...} ... ``` fenced block, in
// document order. An unterminated trailing chunk (an opening fence with no
// matching close) is dropped -- it is not parseable R either way, and
// raiCountFenceOccurrences above already reflects its literal backtick count.
std::vector<std::string> raiExtractRFencedChunks(const std::string& text)
{
   std::vector<std::string> lines;
   boost::split(lines, text, boost::is_any_of("\n"));

   static const boost::regex openFence("^```\\{r[^}]*\\}\\s*$");
   std::vector<std::string> chunks;
   bool inChunk = false;
   std::string current;
   for (const auto& line : lines)
   {
      const std::string trimmed = boost::trim_copy(line);
      if (!inChunk)
      {
         if (boost::regex_match(trimmed, openFence))
         {
            inChunk = true;
            current.clear();
         }
      }
      else if (trimmed == "```")
      {
         chunks.push_back(current);
         inChunk = false;
      }
      else
      {
         if (!current.empty())
            current += "\n";
         current += line;
      }
   }
   return chunks;
}

// Count of extracted chunks that parse without evaluating them -- parse()
// only, never source() or eval(). Requires a live R interpreter, so this is
// only ever called from raiApplyDocumentEdit, never from a pure-function
// unit test.
int raiCountParseableRChunks(const std::vector<std::string>& chunks)
{
   if (chunks.empty())
      return 0;

   r::sexp::Protect protect;
   SEXP resultSEXP = R_NilValue;
   Error error = r::exec::RFunction(".rs.rai.countParseableChunks", chunks).call(&resultSEXP, &protect);
   if (error)
   {
      LOG_ERROR(error);
      return 0;
   }
   if (TYPEOF(resultSEXP) == INTSXP && XLENGTH(resultSEXP) > 0)
      return INTEGER(resultSEXP)[0];
   if (TYPEOF(resultSEXP) == REALSXP && XLENGTH(resultSEXP) > 0)
      return static_cast<int>(REAL(resultSEXP)[0]);
   return 0;
}

RaiBufferAudit raiAuditBufferText(const std::string& text)
{
   RaiBufferAudit audit = raiAuditBufferStructure(text);
   audit.chunkParseCount = raiCountParseableRChunks(raiExtractRFencedChunks(text));
   return audit;
}

// Outcome of one native document-edit apply attempt, including the buffer
// audit computed either way. Private to this translation unit -- only
// raiSubmitApproval (below) needs it, to thread the failure reason and audit
// numbers into .rs.rai.completeDocumentEdit.
struct RaiDocumentEditOutcome
{
   bool wholeFile = false;
   uint64_t sourceRevision = 0;
   std::string postimageMetadata;
   bool applied = false;
   std::string failureReason;
   RaiBufferAudit before;
   RaiBufferAudit after;
   std::string documentId;
   boost::shared_ptr<source_database::SourceDocument> document;
   std::string oldContents;
   std::string newContents;
   bool oldDirty = false;
   std::string operationId, diskPath, diskBytes, diskRevision, backupPath;
   std::string noSaveReason;
};
struct RaiDocumentOperation
{
   RaiDocumentEditOutcome edit;
   bool settled = false;
   std::chrono::steady_clock::time_point started = std::chrono::steady_clock::now();
   std::string savedRevision;
   json::Object result;
};
std::map<std::string, RaiDocumentOperation> s_raiDocumentOperations;

// Bumped only for the document an event names, so another document's event cannot invalidate this document's postimage.
std::map<std::string, uint64_t> s_raiDocumentRevisions;
uint64_t raiDocumentRevision(const std::string& id)
{
   const auto found = s_raiDocumentRevisions.find(id);
   return found == s_raiDocumentRevisions.end() ? 0 : found->second;
}
#ifdef RSTUDIO_UNIT_TESTS_ENABLED
bool s_raiDocumentBackupFailure = false;
#endif

void raiExpireDocumentAcknowledgement(RaiDocumentOperation* operation)
{
   if (operation->settled || std::chrono::steady_clock::now() - operation->started < std::chrono::seconds(30)) return;
   operation->settled = true;
   operation->result["status"] = "error";
   operation->result["saved"] = false;
   operation->result["message"] = "Editor acknowledgement missing; application uncertain; working file not saved. Inspect the editor before retrying.";
   // Native expiry is terminal, so release the same broker request as an
   // acknowledgement would. This never retries the editor mutation or save.
   r::exec::RFunction(".rs.rai.setDocumentEditOutcome", operation->edit.operationId,
      std::string("error"), false, operation->result["message"].getString()).call();
   // Keep the terminal result, not its potentially whole-file payloads.
   operation->edit = RaiDocumentEditOutcome();
}

bool raiBackupDocument(RaiDocumentEditOutcome* outcome)
{
#ifdef RSTUDIO_UNIT_TESTS_ENABLED
   if (s_raiDocumentBackupFailure) return false;
#endif
#ifndef _WIN32
   std::string pattern = module_context::sessionScratchPath().completeChildPath("rai-pre-edit-XXXXXX").getAbsolutePath();
   std::vector<char> name(pattern.begin(), pattern.end()); name.push_back(0);
   RaiDiskFd backup(::mkstemp(name.data()));
   if (backup.fd < 0) return false;
   outcome->backupPath = name.data();
   std::size_t written = 0;
   while (written < outcome->diskBytes.size())
   {
      ssize_t count = ::write(backup.fd, outcome->diskBytes.data() + written, outcome->diskBytes.size() - written);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) return false;
      written += count;
   }
   if (::fsync(backup.fd)) return false;
   std::string digest;
   if (core::system::crypto::sha256Hex(outcome->diskBytes, &digest)) return false;
   json::Object metadata;
   if (outcome->document) outcome->document->writeToJson(&metadata);
   metadata["disk_path"] = outcome->diskPath;
   metadata["disk_sha256"] = digest;
   metadata["backup_path"] = outcome->backupPath;
   const std::string description = metadata.write();
   RaiDiskFd manifest(::open((outcome->backupPath + ".json").c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600));
   if (manifest.fd < 0) return false;
   written = 0;
   while (written < description.size())
   {
      const ssize_t count = ::write(manifest.fd, description.data() + written, description.size() - written);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) return false;
      written += count;
   }
   if (::fsync(manifest.fd)) return false;
   RaiDiskFd directory(::open(FilePath(outcome->backupPath).getParent().getAbsolutePath().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC));
   return directory.fd >= 0 && ::fsync(directory.fd) == 0;
#else
   return false;
#endif
}


Error handleDocumentEditRequest(const http::Request& request,
                                http::Response* pResponse)
{
   if (request.method() != "POST") { pResponse->setStatusCode(http::status::MethodNotAllowed); return Success(); }
   if (!callbackAuthenticated(request, pResponse))
   { pResponse->setStatusCode(http::status::Unauthorized); return Success(); }
   http::Fields fields;
   http::util::parseForm(request.body(), &fields);
   const auto fieldCount = [&fields](const std::string& name)
   {
      return std::count_if(fields.begin(), fields.end(), [&name](const http::Fields::value_type& field)
      {
         return field.first == name;
      });
   };
   // context_before/context_after are optional for a .R document and
   // mandatory for a .Rmd one (checked below, once the document type is
   // known), but at the wire boundary they must arrive together or not at
   // all -- a lone context field can never anchor an edit by itself.
   const bool contextPairPresent = fieldCount("context_before") == 1 && fieldCount("context_after") == 1;
   const bool contextPairAbsent = fieldCount("context_before") == 0 && fieldCount("context_after") == 0;
   const bool wholeFile = fieldCount("contents") == 1 && fieldCount("expected_digest") == 1;
   const std::size_t expectedFieldCount = contextPairPresent ? 5 : 3;
   if (!wholeFile && (fields.size() != expectedFieldCount || fieldCount("document_id") != 1 ||
       fieldCount("expected_text") != 1 || fieldCount("replacement") != 1 ||
       !(contextPairPresent || contextPairAbsent)))
      return raiBadRequest(pResponse, "edit_document requires document_id, expected_text, and replacement, "
                                       "plus context_before and context_after together or not at all");
   const std::string id = http::util::fieldValue<std::string>(fields, "document_id", "");
   if (wholeFile && (fields.size() != 3 || fieldCount("document_id") != 1))
      return raiBadRequest(pResponse, "whole-buffer and snippet arguments are mutually exclusive");
   const std::string expectedDigest = http::util::fieldValue<std::string>(fields, "expected_digest", "");
   std::string expected = http::util::fieldValue<std::string>(fields, "expected_text", "");
   const std::string replacement = http::util::fieldValue<std::string>(fields, wholeFile ? "contents" : "replacement", "");
   if (!wholeFile && (expected.empty() || expected.size() > kRaiMaxDocumentEditTextBytes || replacement.size() > kRaiMaxDocumentEditTextBytes))
      return raiBadRequest(pResponse, "expected_text must be non-empty and both edit texts must be at most 32768 bytes");
   const std::string contextBefore = contextPairPresent ? http::util::fieldValue<std::string>(fields, "context_before", "") : std::string();
   const std::string contextAfter = contextPairPresent ? http::util::fieldValue<std::string>(fields, "context_after", "") : std::string();
   if (contextPairPresent &&
       (contextBefore.empty() || contextBefore.size() > kRaiMaxDocumentEditContextBytes ||
        contextAfter.empty() || contextAfter.size() > kRaiMaxDocumentEditContextBytes))
      return raiBadRequest(pResponse, "context_before and context_after must be non-empty and at most 2048 bytes each");
   if (!wholeFile && (!raiIsBoundedUtf8Text(expected) || !raiIsBoundedUtf8Text(replacement) ||
                      !raiIsBoundedUtf8Text(contextBefore) || !raiIsBoundedUtf8Text(contextAfter)))
      return raiBadRequest(pResponse, "edit texts must be NUL-free UTF-8");

   boost::shared_ptr<source_database::SourceDocument> document;
   std::string message;
   if (!raiLoadDocument(id, &document, &message))
   {
      json::Object refused;
      refused["status"] = "error"; refused["policy"] = "refused"; refused["message"] = message;
      pResponse->setStatusCode(http::status::BadRequest);
      pResponse->setContentType("application/json"); pResponse->setBody(refused.write());
      return Success();
   }

   if (wholeFile)
   {
      if (replacement.size() > kRaiMaxDocumentTotalBytes || document->contents().size() > kRaiMaxDocumentTotalBytes)
      { pResponse->setStatusCode(413); pResponse->setBody("whole-buffer edit exceeds the 10 MiB document reader limit"); return Success(); }
      if (!boost::regex_match(expectedDigest, boost::regex("^[a-f0-9]{64}$")) || !raiIsBoundedUtf8Text(replacement) ||
          !raiIsBoundedUtf8Text(document->contents()))
         return raiBadRequest(pResponse, "invalid whole-buffer digest or UTF-8 text");
      expected = document->contents();
   }

   const std::string postimage = wholeFile ? replacement : contextBefore + replacement + contextAfter;
   const bool postimageHeld = wholeFile ? document->contents() == postimage :
      document->contents().find(postimage) != std::string::npos;

   // Full Auto's documented poll contract is "poll edit_document with
   // identical arguments until it reports applied or error". By the time a
   // caller's second poll arrives, the first poll may already have applied
   // the replacement -- the open buffer then legitimately no longer
   // contains expected_text (the replacement text is there instead), so
   // re-running the native anchor/context validation below on every poll
   // would reject an already-settled, correctly-cached request as if it
   // were a fresh, now-stale proposal. Consult the R-side cache for this
   // exact (document, expected/replacement/context) proposal FIRST: a hit
   // here is authoritative (it can only be reached by a proposal this
   // broker already vetted and recorded), so it is returned immediately,
   // after current path eligibility, without re-deriving anchor state
   // from a buffer that has moved on.
   {
      r::sexp::Protect protectPeek;
      SEXP peekSEXP = R_NilValue;
      Error peekError = r::exec::RFunction(".rs.rai.peekDocumentEditStatus", id, expected, replacement,
                                           contextBefore, contextAfter, wholeFile, expectedDigest)
         .call(&peekSEXP, &protectPeek);
      if (!peekError && TYPEOF(peekSEXP) == VECSXP)
      {
         json::Value peekResult;
         Error jsonError = r::json::jsonValueFromList(peekSEXP, &peekResult);
         if (!jsonError)
         {
            raiUnwrapSingleElementArrays(&peekResult, {"status", "approval", "request_id", "document_id",
                                                       "message", "policy", "file", "seq", "saved", "reason"});
            pResponse->setContentType("application/json");
            if (peekResult.isObject())
            {
               json::Object cached = peekResult.getObject();
               // write() copies the trace out before cached is replaced. A Value
               // taken from cached aliases that object's storage, so assigning it
               // back after the replacement is a null-string crash in write().
               std::string traceText;
               if (cached.hasMember("trace") && !cached["trace"].isNull())
                  traceText = cached["trace"].write();
               if (!cached.hasMember("saved")) cached["saved"] = false;
               if (cached.hasMember("request_id") && cached["request_id"].isString())
               {
                  const auto operation = s_raiDocumentOperations.find(cached["request_id"].getString());
                  if (operation != s_raiDocumentOperations.end())
                  {
                     raiExpireDocumentAcknowledgement(&operation->second);
                     // The native ack result is authoritative for saved/hash, but it
                     // does not carry the R trace link. Keep that link on the poll.
                     if (operation->second.settled) cached = operation->second.result;
                  }
               }
               // A cached applied result speaks only while the buffer still holds its postimage.
               const bool cachedApplied = cached.hasMember("status") && cached["status"].isString() &&
                  cached["status"].getString() == "applied";
               if (!cachedApplied || postimageHeld)
               {
                  // Do not assign the trace Value onto cached. That CopyFrom uses a
                  // different allocator than the parent object and write() then
                  // dereferences a null string. Splice the already-written JSON.
                  std::string body = cached.write();
                  if (!traceText.empty() && !cached.hasMember("trace") &&
                      !body.empty() && body.back() == '}')
                  {
                     body.pop_back();
                     if (body.size() > 1)
                        body += ',';
                     body += "\"trace\":";
                     body += traceText;
                     body += '}';
                  }
                  pResponse->setBody(body);
                  return Success();
               }
            }
            else
            {
               pResponse->setBody(peekResult.write());
               return Success();
            }
         }
      }
   }

   if (!wholeFile)
   {
      std::string current;
      Error digestError = core::system::crypto::sha256Hex(document->contents(), &current);
      if (digestError) return digestError;
      if (!raiHasReadToken("doc:" + id, current, current, "", &message))
      {
         json::Object refused;
         refused["status"] = "error"; refused["policy"] = "refused"; refused["message"] = message;
         pResponse->setStatusCode(http::status::BadRequest);
         pResponse->setContentType("application/json"); pResponse->setBody(refused.write());
         return Success();
      }
   }
   if (raiDocumentIsReadOnly(document))
      return raiBadRequest(pResponse, "open document is read-only");
   if (raiDocumentIsEnvironmentFile(document))
      return raiBadRequest(pResponse, "refused: environment/profile files are never edited by the Assistant");
   if (wholeFile)
   {
      std::string current;
      Error digestError = core::system::crypto::sha256Hex(document->contents(), &current);
      if (digestError) return digestError;
      if (!raiHasReadToken("doc:" + id, expectedDigest, current, "", &message))
         return raiBadRequest(pResponse, message);
   }
   if (!wholeFile && raiDocumentEditRequiresContext(document->type()) && !contextPairPresent)
      return raiBadRequest(pResponse, "context_before and context_after are required for .Rmd document edits");

   std::size_t matchStart = 0;
   const RaiAnchorValidation validation =
      raiValidateAnchoredEdit(document->contents(), expected, contextBefore, contextAfter, &matchStart);
   if (!wholeFile && validation == RaiAnchorValidation::kNotUnique)
      return raiBadRequest(pResponse, "expected_text must occur exactly once in the current open document");
   if (!wholeFile && validation == RaiAnchorValidation::kContextMismatch)
      return raiBadRequest(pResponse, "context_before and context_after must exactly match the text immediately "
                                       "surrounding expected_text");

   r::sexp::Protect protect;
   SEXP resultSEXP = R_NilValue;
   Error error = r::exec::RFunction(".rs.rai.queueDocumentEdit", id, expected, replacement, contextBefore, contextAfter, wholeFile, expectedDigest)
      .call(&resultSEXP, &protect);
   if (error) return error;
   json::Value result;
   error = r::json::jsonValueFromList(resultSEXP, &result);
   if (error) return error;
   // Same length-1-R-vector-becomes-JSON-array marshaling issue as the peek
   // path above: .rs.rai.queueDocumentEdit's "applying"/"approval_required"/
   // "error" responses (this function's live first-call path, reached on
   // every genuinely new edit_document proposal, including the very first
   // Full Auto request) return plain R character scalars, not
   // .rs.scalar()-classed ones, for the same reason (existing R-level
   // identical() tests). Unwrap here too, or a first-time Full Auto request
   // observes "approval": ["autonomous"] exactly like the poll path did.
   raiUnwrapSingleElementArrays(&result, {"status", "approval", "request_id", "document_id",
                                          "message", "policy", "file", "seq", "saved", "reason"});
   pResponse->setContentType("application/json");
   pResponse->setBody(result.write());
   return Success();
}

RaiDocumentEditOutcome raiApplyDocumentEdit(const std::string& id,
                                            const std::string& expected,
                                            const std::string& replacement,
                                            const std::string& contextBefore,
                                            const std::string& contextAfter,
                                            bool wholeFile = false,
                                            const std::string& expectedDigest = "")
{
   RaiDocumentEditOutcome outcome;
   if ((!wholeFile && (expected.empty() || expected.size() > kRaiMaxDocumentEditTextBytes ||
                       replacement.size() > kRaiMaxDocumentEditTextBytes)) ||
       (wholeFile && (expected.size() > kRaiMaxDocumentTotalBytes || replacement.size() > kRaiMaxDocumentTotalBytes ||
                      !raiIsBoundedUtf8Text(expected) || !raiIsBoundedUtf8Text(replacement))))
   {
      outcome.failureReason = "expected_text/replacement out of bounds";
      return outcome;
   }

   boost::shared_ptr<source_database::SourceDocument> document;
   std::string message;
   if (!raiLoadDocument(id, &document, &message) || raiDocumentIsReadOnly(document) ||
       raiDocumentIsEnvironmentFile(document))
   {
      outcome.failureReason = "document changed, is read-only, or could not be updated";
      return outcome;
   }

   {
      std::string current;
      if (core::system::crypto::sha256Hex(document->contents(), &current) ||
          !raiHasReadToken("doc:" + id, expectedDigest.empty() && !wholeFile ? current : expectedDigest, current, "", &message) || (wholeFile && expected != document->contents()))
      { outcome.failureReason = "read whole file first / file changed since read"; return outcome; }
   }
   // Revalidated here, immediately before apply, independent of the
   // handleDocumentEditRequest check above: time has passed since that
   // check (an approval card may have waited on a human), so the document
   // may no longer match the pinned anchor/context at all.
   std::size_t first = 0;
   const RaiAnchorValidation validation =
      raiValidateAnchoredEdit(document->contents(), expected, contextBefore, contextAfter, &first);
   if (!wholeFile && validation == RaiAnchorValidation::kNotUnique)
   {
      outcome.failureReason = "expected_text no longer occurs exactly once in the document";
      return outcome;
   }
   if (!wholeFile && validation == RaiAnchorValidation::kContextMismatch)
   {
      outcome.failureReason = "context_before/context_after no longer match the surrounding text";
      return outcome;
   }

   if (wholeFile) first = 0;
   const std::string oldContents = document->contents();
   std::string newContents = oldContents;
   newContents.replace(first, expected.size(), replacement);

   outcome.before = raiAuditBufferText(oldContents);
   outcome.after = raiAuditBufferText(newContents);
   if (!raiBufferChangeIsExpected(outcome.before, outcome.after, expected, replacement))
   {
      // Atomic retain: the document is never touched when the audit finds a
      // change outside the requested edit's own semantics.
      outcome.failureReason = "buffer audit detected changes outside the requested edit; mutation aborted";
      return outcome;
   }

   boost::shared_ptr<source_database::SourceDocument> latest;
   std::string currentDigest;
   if (!raiLoadDocument(id, &latest, &message) || raiDocumentIsReadOnly(latest) ||
       latest->contents() != oldContents ||
       core::system::crypto::sha256Hex(latest->contents(), &currentDigest) ||
       !raiHasReadToken("doc:" + id, expectedDigest.empty() && !wholeFile ? currentDigest : expectedDigest,
                        currentDigest, "", &message))
   { outcome.failureReason = "read whole file first / file changed since read"; return outcome; }
   if (!document->path().empty() && document->dirty())
   { outcome.failureReason = "pre-existing human dirtiness: save or discard it before an automatic edit"; return outcome; }
   if (document->path().empty()) outcome.noSaveReason = "untitled document";
   else
   {
      const auto token = s_raiReadTokens.find("doc:" + id);
      std::string bytes, revision;
      const std::string path = module_context::resolveAliasedPath(document->path()).getAbsolutePath();
      const bool collab = !document->collabServer().empty();
      const bool snapshot = !collab && raiDocumentDiskSnapshot(path, &bytes, &revision);
      const bool nonUtf8 = !document->encoding().empty() && document->encoding() != "UTF-8";
      bool normalizedMatch = false;
      if (snapshot && !nonUtf8 && bytes != oldContents)
      {
         std::string normalizedBytes = bytes;
         string_utils::convertLineEndings(&normalizedBytes, string_utils::LineEndingPosix);
         if (normalizedBytes.compare(0, 3, "\xEF\xBB\xBF") == 0) normalizedBytes.erase(0, 3);
         normalizedMatch = normalizedBytes == oldContents;
      }
      // A buffer that differs from disk only by encoding or line-ending normalization is edited in the editor only.
      const bool normalized = !collab && (nonUtf8 || normalizedMatch);
      if (normalized)
      {
         outcome.noSaveReason = "automatic save requires UTF-8 with LF line endings";
         outcome.diskPath = path; outcome.document = document; outcome.documentId = id;
      }
      else
      {
         if (collab || token == s_raiReadTokens.end() ||
             token->second.diskPath != path || token->second.diskRevision.empty() || !snapshot ||
             token->second.diskRevision != revision || token->second.diskBytes != bytes || bytes != oldContents)
         { outcome.failureReason = "disk identity or contents changed since the authorized read"; return outcome; }
         outcome.diskPath = path; outcome.diskBytes = bytes; outcome.diskRevision = revision;
         outcome.document = document; outcome.documentId = id;
         if (!raiBackupDocument(&outcome))
         { outcome.failureReason = "pre-edit disk backup failed; edit refused"; return outcome; }
      }
   }
   s_raiReadTokens.erase("doc:" + id);
   const bool oldDirty = document->dirty();
   document->setContents(newContents);
   document->setDirty(true);
   Error error = source_database::put(document);
   if (error)
   {
      LOG_ERROR(error);
      // put() writes contents and properties separately. Restore both the
      // live object and the persisted source buffer if either write failed;
      // never emit an editor replace_ranges event for an incomplete commit.
      document->setContents(oldContents);
      document->setDirty(oldDirty);
      Error restoreError = source_database::put(document);
      if (restoreError)
         LOG_ERROR(restoreError);
      outcome.failureReason = restoreError ?
         "document update failed and source-buffer rollback could not be persisted" :
         "document changed, is read-only, or could not be updated";
      return outcome;
   }
   outcome.sourceRevision = raiDocumentRevision(id);
   json::Object postimageMetadata;
   document->writeToJson(&postimageMetadata, false);
   outcome.postimageMetadata = postimageMetadata.write();
   outcome.documentId = id;
   outcome.document = document;
   outcome.oldContents = oldContents;
   outcome.newContents = newContents;
   outcome.oldDirty = oldDirty;
   outcome.wholeFile = wholeFile;
   outcome.applied = true;
   return outcome;
}

// Reload after R completion; the retained object does not track live source changes
bool raiLoadDocumentEditPostimage(const RaiDocumentEditOutcome& outcome,
                                boost::shared_ptr<source_database::SourceDocument>* latest,
                                uint64_t revisionAdvance = 0)
{
   std::string message;
   if (!outcome.applied || !outcome.document ||
       outcome.document->id() != outcome.documentId ||
       raiDocumentRevision(outcome.documentId) != outcome.sourceRevision + revisionAdvance ||
       !raiLoadDocument(outcome.documentId, latest, &message) ||
       raiDocumentIsReadOnly(*latest) || raiDocumentIsEnvironmentFile(*latest) ||
       (*latest)->contents() != outcome.newContents)
      return false;
   json::Object metadata;
   (*latest)->writeToJson(&metadata, false);
   return metadata.write() == outcome.postimageMetadata &&
      raiDocumentRevision(outcome.documentId) == outcome.sourceRevision + revisionAdvance;
}

// Completion is durable before the IDE sees the replacement. A trace failure
// therefore has no client-side mutation or Undo entry to reconcile.
bool raiPublishDocumentEdit(const RaiDocumentEditOutcome& outcome)
{
   boost::shared_ptr<source_database::SourceDocument> latest;
   if (!raiLoadDocumentEditPostimage(outcome, &latest))
      return false;
   source_database::events().onDocUpdated(latest);
   // Notification invalidates our revision once; subscribers may also change the buffer
   if (!raiLoadDocumentEditPostimage(outcome, &latest, 1))
      return false;
   {
      std::string digest;
      if (!core::system::crypto::sha256Hex(outcome.newContents, &digest))
         raiObserveRead("doc:" + outcome.documentId, digest, "", 0, outcome.newContents.size(), outcome.newContents.size());
   }
   std::vector<std::string> oldLines;
   boost::split(oldLines, outcome.oldContents, boost::is_any_of("\n"));
   const int lastRow = static_cast<int>(oldLines.size()) - 1;
   const int lastCol = oldLines.empty() ? 0 : raiUtf8ToUtf16CodeUnitCount(oldLines.back());
   json::Object data;
   data["id"] = outcome.documentId;
   data["rai_edit"] = true;
   data["operation_id"] = outcome.operationId;
   data["require_clean"] = outcome.noSaveReason.empty();
   data["expected_contents"] = outcome.oldContents;
   json::Array range; range.push_back(0); range.push_back(0); range.push_back(lastRow); range.push_back(lastCol);
   json::Array ranges; ranges.push_back(range); data["ranges"] = ranges;
   json::Array text; text.push_back(outcome.newContents); data["text"] = text;
   json::Object eventData; eventData["type"] = "replace_ranges"; eventData["data"] = data;
   module_context::enqueClientEvent(ClientEvent(client_events::kEditorCommand, eventData));
   return true;
}

bool raiRollbackDocumentEdit(const RaiDocumentEditOutcome& outcome, const std::string& editorPostimage = "", bool published = false)
{
   auto saved = s_raiDocumentOperations.find(outcome.operationId);
   if (saved != s_raiDocumentOperations.end() && saved->second.result.hasMember("saved") &&
       saved->second.result["saved"].getBool())
   {
      // Disk rollback requires a fresh editor acknowledgement; ordinary editor Undo is buffer-only.
      boost::shared_ptr<source_database::SourceDocument> latest;
      std::string message, bytes, revision;
      auto guard = [&]() -> Error
      {
         if (editorPostimage != outcome.newContents ||
             !raiLoadDocument(outcome.documentId, &latest, &message) ||
             raiDocumentIsReadOnly(latest) || raiDocumentIsEnvironmentFile(latest) ||
             !latest->collabServer().empty() || latest->contents() != outcome.newContents ||
             module_context::resolveAliasedPath(latest->path()).getAbsolutePath() != outcome.diskPath ||
             !raiDocumentDiskSnapshot(outcome.diskPath, &bytes, &revision) ||
             bytes != outcome.newContents || revision != saved->second.savedRevision)
            return Error(json::errc::ParamInvalid, ERROR_LOCATION);
         std::string backup;
         if (readStringFromFile(FilePath(outcome.backupPath), &backup) || backup != outcome.diskBytes ||
             backup != outcome.oldContents) return Error(json::errc::ParamInvalid, ERROR_LOCATION);
         return Success();
      };
      Error error = guard();
      if (!error) error = source::saveRaiDocument(latest, outcome.oldContents, guard);
      if (error) return false;
      saved->second.result["rolled_back"] = true;
      return true;
   }
   boost::shared_ptr<source_database::SourceDocument> latest;
   if (!raiLoadDocumentEditPostimage(outcome, &latest, published ? 1 : 0))
      return false;
   latest->setContents(outcome.oldContents);
   latest->setDirty(outcome.oldDirty);
   Error error = source_database::put(latest);
   if (error)
   {
      LOG_ERROR(error);
      return false;
   }
   return true;
}


json::Object raiAcknowledgeDocumentEdit(const std::string& operationId, bool accepted, const std::string& contents)
{
   auto found = s_raiDocumentOperations.find(operationId);
   json::Object result; result["status"] = "error"; result["saved"] = false;
   if (found == s_raiDocumentOperations.end())
   { result["message"] = "unknown edit operation; do not replay"; return result; }
   auto& operation = found->second;
   raiExpireDocumentAcknowledgement(&operation);
   if (operation.settled) return operation.result;
   // Settle before entering save code: a write or metadata failure must never be replayed.
   // Status stays "applying" until the final outcome is known, so a poll during
   // the save does not look like a terminal error.
   operation.settled = true;
   operation.result = result;
   operation.result["status"] = "applying";
   operation.result["message"] = "Edit outcome uncertain; inspect editor and disk. Do not replay.";
   // All acknowledgement paths are terminal. Release payloads only after
   // their save/rollback work is finished, including early failure returns.
   BOOST_SCOPE_EXIT_ALL(&) { operation.edit = RaiDocumentEditOutcome(); };
   const auto& edit = operation.edit;
   if (!accepted || contents != edit.newContents)
   {
      const bool restored = raiRollbackDocumentEdit(edit, "", true);
      result["status"] = "conflict";
      result["message"] = restored ? "Editor conflict; edit not applied. Human buffer preserved." :
         "Editor conflict; edit not applied in the editor, but the source buffer could not be restored. Inspect the open buffer.";
   }
   else
   {
      result["status"] = "applied";
      std::string reason = edit.noSaveReason;
      boost::shared_ptr<source_database::SourceDocument> latest;
      std::string message;
      auto guard = [&]() -> Error
      {
         std::string bytes, revision, backup;
         bool authorized = false;
         Error authError = r::exec::RFunction(".rs.rai.documentSaveAuthorized", operationId, edit.documentId).call(&authorized);
         if (authError || !authorized || !raiLoadDocumentEditPostimage(edit, &latest, 1) ||
             raiDocumentIsReadOnly(latest) || raiDocumentIsEnvironmentFile(latest) ||
             !latest->collabServer().empty() || latest->contents() != edit.newContents ||
             module_context::resolveAliasedPath(latest->path()).getAbsolutePath() != edit.diskPath ||
             !raiDocumentDiskSnapshot(edit.diskPath, &bytes, &revision) ||
             bytes != edit.diskBytes || revision != edit.diskRevision ||
             edit.backupPath.empty() || readStringFromFile(FilePath(edit.backupPath), &backup) || backup != edit.diskBytes)
            return Error(json::errc::ParamInvalid, ERROR_LOCATION);
         return Success();
      };
      const auto retainDirty = [&]()
      {
         boost::shared_ptr<source_database::SourceDocument> live;
         if (raiLoadDocument(edit.documentId, &live, &message) && live->contents() == edit.newContents)
         { live->setDirty(true); source_database::put(live); }
      };
      if (reason.empty())
      {
         std::string beforeDigest, afterDigest;
         Error error = core::system::crypto::sha256Hex(edit.diskBytes, &beforeDigest);
         if (!error) error = core::system::crypto::sha256Hex(edit.newContents, &afterDigest);
         if (!error && !raiDiskTrace("document_save_requested", edit.diskPath, beforeDigest, afterDigest))
            error = Error(json::errc::ParamInvalid, ERROR_LOCATION);
         if (!error) error = guard();
         if (!error) error = source::saveRaiDocument(latest, edit.newContents, guard);
         std::string bytes, revision;
         if (error)
         {
            // The working write may already have completed. Retain the dirty buffer and never retry.
            reason = "save failed or acknowledgement uncertain; inspect disk before retrying";
            retainDirty();
         }
         else if (!raiDocumentDiskSnapshot(edit.diskPath, &bytes, &revision) || bytes != edit.newContents ||
                  !raiLoadDocument(edit.documentId, &latest, &message) || latest->contents() != edit.newContents ||
                  latest->dirty() || latest->created() != edit.document->created())
         {
            reason = "saved bytes could not be verified; inspect disk";
            retainDirty();
         }
         else
         {
            operation.savedRevision = revision;
            result["saved"] = true;
            result["backup_path"] = edit.backupPath;
            result["backup_sha256"] = beforeDigest;
            if (!raiDiskTrace("document_saved", edit.diskPath, beforeDigest, afterDigest))
               result["message"] = "Edit applied and disk saved; save-result trace unavailable. Do not replay.";
            result["hash"] = latest->hash();
            result["path"] = latest->path();
         }
      }
      if (!reason.empty())
      {
         result["reason"] = reason;
         result["message"] = "Edit applied; file not saved: " + reason;
      }
   }
   operation.result = result;
   return result;
}

Error raiDocumentEditAck(const json::JsonRpcRequest& request, json::JsonRpcResponse* response)
{
   std::string operationId, contents; bool accepted;
   Error error = json::readParams(request.params, &operationId, &accepted, &contents);
   if (error) return error;
   json::Object result = raiAcknowledgeDocumentEdit(operationId, accepted, contents);
   r::exec::RFunction(".rs.rai.setDocumentEditOutcome", operationId, result["status"].getString(),
      result["saved"].getBool(), result.hasMember("message") ? result["message"].getString() : std::string()).call();
   response->setResult(result);
   return Success();
}

} // anonymous namespace

bool raiDocumentEditRequiresContext(const std::string& documentType)
{
   return documentType == kSourceDocumentTypeRMarkdown;
}

RaiAnchorValidation raiValidateAnchoredEdit(const std::string& documentText,
                                            const std::string& expected,
                                            const std::string& contextBefore,
                                            const std::string& contextAfter,
                                            std::size_t* pMatchStart)
{
   const std::size_t first = documentText.find(expected);
   if (first == std::string::npos || documentText.find(expected, first + 1) != std::string::npos)
      return RaiAnchorValidation::kNotUnique;

   if (!contextBefore.empty() &&
       (first < contextBefore.size() ||
        documentText.compare(first - contextBefore.size(), contextBefore.size(), contextBefore) != 0))
      return RaiAnchorValidation::kContextMismatch;

   if (!contextAfter.empty())
   {
      const std::size_t afterStart = first + expected.size();
      if (afterStart + contextAfter.size() > documentText.size() ||
          documentText.compare(afterStart, contextAfter.size(), contextAfter) != 0)
         return RaiAnchorValidation::kContextMismatch;
   }

   if (pMatchStart)
      *pMatchStart = first;
   return RaiAnchorValidation::kOk;
}

RaiBufferAudit raiAuditBufferStructure(const std::string& text)
{
   RaiBufferAudit audit;
   std::vector<std::string> lines;
   boost::split(lines, text, boost::is_any_of("\n"));
   audit.totalLines = static_cast<int>(lines.size());
   audit.blankLines = static_cast<int>(std::count_if(lines.begin(), lines.end(),
      [](const std::string& line) { return line.empty(); }));
   audit.fenceCount = raiCountFenceOccurrences(text);
   return audit;
}

bool raiBufferChangeIsExpected(const RaiBufferAudit& before,
                               const RaiBufferAudit& after,
                               const std::string& expected,
                               const std::string& replacement)
{
   const int expectedLineDelta =
      static_cast<int>(std::count(replacement.begin(), replacement.end(), '\n')) -
      static_cast<int>(std::count(expected.begin(), expected.end(), '\n'));
   const int expectedFenceDelta =
      raiCountFenceOccurrences(replacement) - raiCountFenceOccurrences(expected);
   return (after.totalLines - before.totalLines == expectedLineDelta) &&
          (after.fenceCount - before.fenceCount == expectedFenceDelta);
}

// Bounded classifier: never touches the network, R, or the filesystem, and
// never returns the URL it was given. RStudio's own session-temp resource
// URLs (the loopback help-server form "http://127.0.0.1:<port>/session/<path>"
// and the server-mode relative form "session/<path>") are the only ones
// classified as transport "session_temp"; every other non-empty URL is
// reported only as transport "http", with no host/path/query detail.
void raiClassifyViewerState(const std::string& viewerUrl,
                            bool isHTMLWidget,
                            bool* pActive,
                            std::string* pKind,
                            std::string* pTransport)
{
   static const boost::regex sessionTempPattern(
      "^(?:https?://127\\.0\\.0\\.1(?::[0-9]+)?/)?session/.*");

   *pActive = !viewerUrl.empty();
   if (!*pActive)
   {
      *pKind = "none";
      *pTransport = "none";
      return;
   }

   *pKind = isHTMLWidget ? "html_widget" : "other";
   *pTransport = boost::regex_match(viewerUrl, sessionTempPattern)
      ? "session_temp" : "http";
}

// Test-only: drives the same process-global token the real endpoint checks,
// so a unit test can exercise the 401 branch without a live listener.
void raiSetSessionEndpointTokenForTests(const std::string& token)
{
   s_sessionEndpointToken = token;
}

// r::json::jsonValueFromList() (see r/RJson.cpp) marshals every length-1 R
// atomic field as a one-element JSON array unless the R value is explicitly
// classed "rs.scalar"/"AsIs" -- most call sites here build their R response
// lists as plain, un-.rs.scalar()'d strings (so they still compare cleanly
// with base R identical() in the existing R-level testthat suite; see
// SessionRaiAssistant.R's edit_document family), which means results
// crossing this exact json::jsonValueFromList() boundary need to be
// unwrapped back to scalars afterward, at the JSON layer, rather than by
// reclassing every R list literal at its many call sites. Applied to the
// edit_document family (queueDocumentEdit / peekDocumentEditStatus
// responses, both the live first-call path and every subsequent poll): a
// caller (the bridge, the MCP tool caller) that reads e.g. `.approval` or
// `.trace.seq` as a bare string/int must see one, not `["autonomous"]` / a
// 1-element array.
//
// Only the caller's documented scalar fields may be normalized: at the root
// and directly inside the trace link. Other nested payloads (data_effects,
// capabilities, etc.) and multi-element arrays keep their original shape.
void raiUnwrapSingleElementArrays(json::Value* pValue, const std::vector<std::string>& fields)
{
   if (!pValue->isObject())
      return;

   // getObject() aliases pValue's Document. Mutate its members in place;
   // assigning this view back to pValue would CopyFrom itself.
   json::Object object = pValue->getObject();
   const auto unwrapFields = [&fields](json::Object* pObject)
   {
      for (const std::string& field : fields)
      {
         json::Object::Iterator it = pObject->find(field);
         if (it == pObject->end())
            continue;
         json::Value fieldValue = (*it).getValue();
         if (!fieldValue.isArray())
            continue;
         json::Array array = fieldValue.getArray();
         if (array.getSize() != 1)
            continue;

         // Array::operator[] returns a temporary alias. Constructing Value
         // directly from it selects the MOVE constructor, which moves out of
         // the child and turns it null. clone() forces an independent copy.
         json::Value scalar = array[static_cast<std::size_t>(0)].clone();
         (*pObject)[field] = scalar;
      }
   };
   unwrapFields(&object);

   json::Object::Iterator trace = object.find("trace");
   if (trace != object.end() && (*trace).getValue().isObject())
   {
      json::Object traceObject = (*trace).getValue().getObject();
      unwrapFields(&traceObject);
   }
}

namespace {

// Forward declaration: handleReadProjectFileRequest is defined below
// raiProjectCwd() (its root helper) but is dispatched from
// processSessionEndpointRequest, which appears earlier in this namespace.
Error handleReadProjectFileRequest(const http::Request& request,
                                   http::Response* pResponse);

// This is the /viewer counterpart to /plot: read-only, POST-only, token
// gated, and it accepts no body fields. It never serializes the viewer's raw
// URL/host/path/query/fragment -- only the bounded active/kind/transport
// summary that raiClassifyViewerState derives from it. It calls no R
// function, touches no FilePath, and enqueues nothing to the Console.
Error handleViewerStateRequest(const http::Request& request,
                               http::Response* pResponse)
{
   if (request.method() != "POST")
   {
      pResponse->setStatusCode(http::status::MethodNotAllowed);
      return Success();
   }

   if (!callbackAuthenticated(request, pResponse))
   {
      pResponse->setStatusCode(http::status::Unauthorized);
      return Success();
   }

   if (!request.body().empty())
      return raiBadRequest(pResponse, "get_viewer_state accepts no arguments");

   bool active = false;
   std::string kind;
   std::string transport;
   raiClassifyViewerState(module_context::viewerCurrentUrl(),
                          module_context::viewerIsHTMLWidget(),
                          &active, &kind, &transport);

   json::Object result;
   result.insert("active", active);
   result.insert("kind", kind);
   result.insert("transport", transport);

   pResponse->setContentType("application/json");
   pResponse->setBody(result.write());
   return Success();
}

Error ensureSessionEndpointStarted()
{
   if (s_sessionEndpointListener)
      return Success();

   s_sessionEndpointListener.reset(new RaiSessionEndpointListener());
   Error error = s_sessionEndpointListener->start();
   if (error)
   {
      s_sessionEndpointListener.reset();
      return error;
   }
   return Success();
}

void processSessionEndpointRequest(boost::shared_ptr<HttpConnection> connection)
{
   http::Response response;
   const std::string uri = connection->request().uri();
   Error error;
   if (uri == "/health")
      error = handleSessionHealthRequest(connection->request(), &response);
   else if (uri == "/run")
      error = handleConsoleRunRequest(connection->request(), &response);
   else if (uri == "/result")
      error = handleConsoleResultRequest(connection->request(), &response);
   else if (uri == "/settings")
      error = handleSettingsRequest(connection->request(), &response);
   else if (uri == "/authorize_derived")
      error = handleAuthorizeDerivedRequest(connection->request(), &response);
   else if (uri == "/monitor")
      error = handleConsoleMonitorRequest(connection->request(), &response);
   else if (uri == "/debug")
      error = handleConsoleDebugInfoRequest(connection->request(), &response);
   else if (uri == "/plot")
      error = handlePlotImageRequest(connection->request(), &response);
   else if (uri == "/plots")
      error = handlePlotHistoryRequest(connection->request(), &response);
   else if (uri == "/project_context")
      error = handleProjectContextRequest(connection->request(), &response);
   else if (uri == "/environment")
      error = handleEnvironmentSummaryRequest(connection->request(), &response);
   else if (uri == "/viewer")
      error = handleViewerStateRequest(connection->request(), &response);
   else if (uri == "/active_document")
      error = handleActiveDocumentRequest(connection->request(), &response);
   else if (uri == "/documents")
      error = handleOpenDocumentsRequest(connection->request(), &response);
   else if (uri == "/document")
      error = handleOpenDocumentRequest(connection->request(), &response);
   else if (uri == "/notebook_outputs")
      error = handleNotebookOutputRequest(connection->request(), &response, false);
   else if (uri == "/notebook_image")
      error = handleNotebookOutputRequest(connection->request(), &response, true);
   else if (uri == "/edit")
      error = handleDocumentEditRequest(connection->request(), &response);
   else if (uri == "/write")
      error = handleWriteProjectFileRequest(connection->request(), &response);
   else if (uri == "/file")
      error = handleReadProjectFileRequest(connection->request(), &response);
   else
      response.setStatusCode(http::status::NotFound);

   if (error)
   {
      LOG_ERROR(error);
      response.setStatusCode(http::status::InternalServerError);
   }
   response.setHeader("Cache-Control", "no-store");
   connection->sendResponse(response);
}

void onBackgroundProcessing(bool)
{
   // Flush natively-captured Console results into the R registry, and reclaim
   // the capture slot if a run never returned to a top-level prompt.
   raiFlushPendingStores();
   raiExpireStuckCapture();
   for (auto& operation : s_raiDocumentOperations)
      raiExpireDocumentAcknowledgement(&operation.second);

   if (!s_sessionEndpointListener)
      return;

   for (int i = 0; i < 4; ++i)
   {
      boost::shared_ptr<HttpConnection> connection =
         s_sessionEndpointListener->mainConnectionQueue().dequeConnection();
      if (!connection)
         break;
      processSessionEndpointRequest(connection);
   }
}

void onShutdown(bool)
{
   if (s_sessionEndpointListener)
      s_sessionEndpointListener->stop();
   { boost::mutex::scoped_lock lock(s_callbackMutex); s_callbackChallenges.clear(); s_callbackAdmissions.clear(); s_callbackReaper.reset(); }
   s_sessionEndpointListener.reset();
   s_sessionEndpointToken.clear();

   boost::mutex::scoped_lock lock(s_captureMutex);
   raiResetCaptureLocked();
   s_pendingStores.clear();
}

// Prefer the copy packaged inside the app bundle so the DMG/installer is
// self-contained on a machine that never had the rai-chat-bridge checkout.
// nodePath's parent-walk depth to the "app" resource root differs by
// platform: on macOS it resolves to
// .../Contents/Resources/app/bin/<node-dir>/bin/node (see
// node_tools::findNode / macBinaryPath), so four levels up is "app". On
// Windows, kDefaultNodePath is the flatter "bin/node" (SessionConstants.hpp)
// with no nested bin/node/bin -- node.exe sits directly under
// resources/app/bin/node/, so the same resource root is only THREE levels
// up. Try both depths (3 first, since node.exe with no subfolder nesting is
// the common case outside macOS) rather than hardcoding one assumption that
// silently falls through to RAI_BRIDGE_DIR or an empty (missing) path on
// every other platform if it's wrong.
FilePath resolveBridgeDir(const FilePath& nodePath)
{
   if (!nodePath.isEmpty())
   {
      FilePath fourUp = nodePath.getParent().getParent().getParent().getParent()
         .completeChildPath("rai-chat-bridge");
      FilePath threeUp = nodePath.getParent().getParent().getParent()
         .completeChildPath("rai-chat-bridge");

      for (const FilePath& candidate : { threeUp, fourUp })
      {
         if (candidate.completeChildPath("server.js").exists())
            return candidate;
      }
   }

   std::string dir = core::system::getenv("RAI_BRIDGE_DIR");
   if (!dir.empty())
      return FilePath(dir);

   return FilePath();
}

FilePath raiProjectCwd()
{
   if (projects::projectContext().hasProject())
      return projects::projectContext().directory();
   return module_context::safeCurrentPath();
}

// Bounded read of ONE project-relative text file. This is the only endpoint
// in this file that turns a caller-supplied string into a FilePath, so it
// carries the full weight of that contract:
//  - path plus an optional canonical decimal byte offset are the only fields
//  - the raw path must pass raiIsValidProjectRelativePathArgument
//    (non-empty, no NUL, no absolute/".." component) before touching disk
//  - there must be an active RStudio project; there is deliberately no
//    working-directory or home-directory fallback root, for the same reason
//    handleProjectContextRequest has none
//  - the path is completed against the project root and then re-validated
//    with FilePath::isWithin() on the CANONICAL form of both sides, so a
//    symlink that resolves outside the root is caught even though the
//    syntactic ".." check already passed
//  - only a regular file is served: no directories, no symlinks-as-such
//  - text files up to kRaiMaxProjectFileTotalBytes are accepted, but every
//    response contains at most kRaiMaxProjectFileBytes and a continuation
//    offset at a UTF-8 boundary
//  - content must be bounded UTF-8 text with no embedded NUL
// The response never contains an absolute path -- only the same
// caller-supplied relative path is echoed back -- and this function never
// writes, lists a directory, or reads anything through Node.
Error handleReadProjectFileRequest(const http::Request& request,
                                   http::Response* pResponse)
{
   if (request.method() != "POST")
   {
      pResponse->setStatusCode(http::status::MethodNotAllowed);
      return Success();
   }

   if (!callbackAuthenticated(request, pResponse))
   {
      pResponse->setStatusCode(http::status::Unauthorized);
      return Success();
   }

   http::Fields fields;
   http::util::parseForm(request.body(), &fields);
   std::string requestedPath;
   std::string offsetField("0");
   bool sawPath = false;
   bool sawOffset = false;
   for (const http::Field& field : fields)
   {
      if (field.first == "path" && !sawPath)
      {
         requestedPath = field.second;
         sawPath = true;
      }
      else if (field.first == "offset" && !sawOffset)
      {
         offsetField = field.second;
         sawOffset = true;
      }
      else
      {
         return raiBadRequest(pResponse, "read_project_file requires path and optional offset only");
      }
   }
   if (!sawPath)
      return raiBadRequest(pResponse, "read_project_file requires path");

   std::size_t offset = 0;
   if (!raiParseProjectFileOffsetField(offsetField, &offset))
      return raiBadRequest(pResponse, "offset must be a non-negative canonical decimal byte offset");

   if (!raiIsValidProjectRelativePathArgument(requestedPath))
      return raiBadRequest(pResponse, "path must be a non-empty project-relative path with no absolute "
                                       "component, \"..\" component, or NUL byte");
   if (raiIsEnvironmentFilePath(requestedPath, true))
      return raiBadRequest(pResponse, "protected environment/profile file cannot be read by the Assistant");

   // An active RStudio project is the ONLY root this endpoint may resolve
   // against -- same posture as /project_context, and for the same reason:
   // on a fresh desktop session with no project open, any fallback root
   // (working or home directory) is not a bounded, user-chosen scope.
   if (raiDiskProjectRoot().isEmpty())
      return raiBadRequest(pResponse, "read_project_file requires an active RStudio project");

   const FilePath root = raiDiskProjectRoot();

   FilePath resolved;
   Error error = root.completeChildPath(requestedPath, resolved);
   if (error)
      return raiBadRequest(pResponse, "path could not be resolved");

   // Re-validate on the canonical form of both paths: completeChildPath
   // already rejects a syntactically absolute argument, and
   // raiIsValidProjectRelativePathArgument already rejected any ".."
   // component, but neither one follows a symlink. getCanonicalPath()
   // resolves symlinks (including one nested inside an intermediate
   // directory), so isWithin() here is the actual escape-proof boundary.
   if (!resolved.exists())
      return raiBadRequest(pResponse, "path does not exist in the active project");

   const FilePath canonicalRoot(root.getCanonicalPath());
   const FilePath canonicalResolved(resolved.getCanonicalPath());
   if (!canonicalResolved.isWithin(canonicalRoot))
      return raiBadRequest(pResponse, "path resolves outside the active project");
   if (raiIsEnvironmentFilePath(canonicalResolved.getAbsolutePath(), true))
      return raiBadRequest(pResponse, "protected environment/profile file cannot be read by the Assistant");

   if (canonicalResolved.isDirectory())
      return raiBadRequest(pResponse, "path is a directory, not a file");
   if (!canonicalResolved.isRegularFile())
      return raiBadRequest(pResponse, "path is not a regular file");

   const std::string revision = raiFileRevision(canonicalResolved);
   const std::uintmax_t fileSize = canonicalResolved.getSize();
   if (fileSize > kRaiMaxProjectFileTotalBytes)
      return raiBadRequest(pResponse, "file exceeds the 10 MB paged-read limit");
   if (offset > fileSize)
      return raiBadRequest(pResponse, "offset exceeds file size");

   std::string page;
   if (!raiReadProjectFilePage(canonicalResolved, static_cast<std::size_t>(fileSize), offset, &page))
      return raiBadRequest(pResponse, "file could not be read as stable UTF-8/plain text");

   if (revision != raiFileRevision(canonicalResolved))
      return raiBadRequest(pResponse, "file revision changed during bounded read");

   // An offset must not cut a multi-byte character. End is moved backward to
   // the previous UTF-8 boundary, making each response independently valid.
   std::size_t end = std::min(page.size(), kRaiMaxProjectFileBytes);
   while (offset + end < fileSize && end > 0 &&
          (static_cast<unsigned char>(page[end]) & 0xC0) == 0x80)
      --end;

   std::string fullContents, digest;
   if (raiResolvedWritePathClass(resolved.getAbsolutePath()) == RaiWriteClass::kCode)
   {
      std::shared_ptr<std::istream> stream;
      Error readError = canonicalResolved.openForRead(stream);
      if (!readError)
      {
         fullContents.resize(static_cast<std::size_t>(fileSize) + 1);
         stream->read(&fullContents[0], static_cast<std::streamsize>(fullContents.size()));
         fullContents.resize(static_cast<std::size_t>(stream->gcount()));
      }
      if (readError || fullContents.size() != fileSize || !raiIsBoundedUtf8Text(fullContents) ||
          fullContents.compare(offset, end, page, 0, end) != 0 || revision != raiFileRevision(canonicalResolved))
         return raiBadRequest(pResponse, "file changed during full-content digest read");
      Error digestError = core::system::crypto::sha256Hex(fullContents, &digest);
      if (digestError) return digestError;
      raiObserveRead("disk:" + canonicalResolved.getAbsolutePath(), digest, revision, offset, offset + end, fileSize);
   }
   json::Object result;
   result.insert("path", requestedPath);
   if (!digest.empty()) result.insert("content_digest", digest);
   result.insert("offset", static_cast<uint64_t>(offset));
   result.insert("total_bytes", static_cast<uint64_t>(fileSize));
   result.insert("audit_revision", revision);
   result.insert("text", page.substr(0, end));
   const bool hasMore = offset + end < fileSize;
   result.insert("truncated", hasMore);
   if (hasMore)
      result.insert("next_offset", static_cast<uint64_t>(offset + end));
   else
      result.insert("next_offset", json::Value());
   pResponse->setContentType("application/json");
   pResponse->setBody(result.write());
   return Success();
}

// Bind port 0 and let the OS hand back a free port, then release it for node.
Error allocatePort(int* pPort)
{
   using boost::asio::ip::tcp;
   boost::asio::io_context ioContext;
   tcp::acceptor acceptor(ioContext);

   boost::system::error_code ec;
   tcp::endpoint endpoint(tcp::v4(), 0);
   acceptor.open(endpoint.protocol(), ec);
   if (ec)
      return systemError(ec, ERROR_LOCATION);

   acceptor.bind(endpoint, ec);
   if (ec)
      return systemError(ec, ERROR_LOCATION);

   *pPort = acceptor.local_endpoint().port();
   acceptor.close();
   return Success();
}

// True once the bridge is accepting connections on the loopback port.
bool bridgeReady(int port)
{
   if (port <= 0)
      return false;

   using boost::asio::ip::tcp;
   boost::asio::io_context ioContext;
   tcp::socket socket(ioContext);
   tcp::endpoint endpoint(
      boost::asio::ip::make_address("127.0.0.1"),
      static_cast<unsigned short>(port));

   boost::system::error_code ec;
   socket.connect(endpoint, ec);
   if (!ec)
   {
      socket.close(ec);
      return true;
   }
   return false;
}

// The connect timeout does not bound the response read, so the whole request gets a deadline.
Error sendBridgeLoopbackRequest(int port,
                                const http::Request& request,
                                http::Response* pResponse)
{
   boost::asio::io_context ioContext;
   boost::shared_ptr<http::TcpIpAsyncClient> pClient(new http::TcpIpAsyncClient(
      ioContext, "127.0.0.1", boost::lexical_cast<std::string>(port),
      boost::posix_time::seconds(2)));
   pClient->setRequestTimeout(boost::posix_time::seconds(2));
   return http::sendRequest<boost::asio::ip::tcp::socket>(
      ioContext, pClient, request, pResponse);
}

Error refreshBridgeWorkspace(int port, bool* pAuthFailed = nullptr)
{
   if (pAuthFailed) *pAuthFailed = false;
   auto rejected = [&]() {
      if (pAuthFailed) *pAuthFailed = true;
      return Error(boost::system::errc::make_error_code(boost::system::errc::protocol_error),
                   "RAI bridge peer proof failed", ERROR_LOCATION);
   };
   if (port <= 0 || s_sessionEndpointToken.empty()) return rejected();
   unsigned char random[32];
   if (RAND_bytes(random, sizeof(random)) != 1) return rejected();
   const std::string nn = peerHex(random, sizeof(random));
   json::Object challenge;
   challenge["v"] = 1;
   challenge["nn"] = nn;
   http::Request request;
   request.setMethod("POST");
   request.setUri("/api/peer-challenge");
   request.setContentType("application/json");
   request.setBody(challenge.write());
   http::Response response;
   Error error = sendBridgeLoopbackRequest(port, request, &response);
   if (error) return error;
   if (response.statusCode() != http::status::Ok) return rejected();
   json::Object answer;
   if (answer.parse(response.body())) return rejected();
   std::string nb, proof, expected;
   if (json::readObject(answer, "nb", nb, "proof", proof) || nb.size() != 64 ||
       nb.find_first_not_of("0123456789abcdef") != std::string::npos) return rejected();
   error = peerMac("bridge-proof", nn, nb, port, "", &expected);
   if (error) return error;
   if (!peerMatches(proof, expected)) return rejected();

   json::Object payload;
   payload["cwd"] = raiProjectCwd().getAbsolutePath();
   const std::string body = payload.write();
   error = peerMac("native-proof", nn, nb, port, body, &proof);
   if (error) return error;
   http::Request workspace;
   workspace.setMethod("POST");
   workspace.setUri("/api/workspace");
   workspace.setContentType("application/json");
   workspace.setHeader("X-RAI-Peer-Nonce", nb);
   workspace.setHeader("X-RAI-Peer-Proof", proof);
   workspace.setBody(body);
   http::Response ackResponse;
   error = sendBridgeLoopbackRequest(port, workspace, &ackResponse);
   if (error) return error;
   if (ackResponse.statusCode() != http::status::Ok) return rejected();
   json::Object ack;
   std::string received;
   if (ack.parse(ackResponse.body()) || json::readObject(ack, "ack", received)) return rejected();
   error = peerMac("bridge-ack", nn, nb, port, body, &expected);
   if (error) return error;
   if (!peerMatches(received, expected)) return rejected();
   return Success();
}

// Directory backing all per-window RAI Assistant state (bridge state file,
// bridge log). Kept private (0700 on POSIX, never a shared/world-writable tmp
// path) since RAI_BRIDGE_TOKEN and other secrets flow through files here.
FilePath raiStudioDir()
{
   FilePath dir = core::system::userHomePath().completeChildPath(".raistudio");
   Error error = dir.ensureDirectory();
   if (error)
      LOG_ERROR(error);
#ifndef _WIN32
   error = dir.changeFileMode(FileMode::USER_READ_WRITE_EXECUTE);
   if (error)
      LOG_ERROR(error);
#endif
   return dir;
}

// Where this window's already-running bridge port is persisted -- keyed by
// the fixed per-window RAI port (see raiSessionEndpointPort()) so a fresh
// rsession after "Restart R" can find and reconnect to the still-running
// bridge (survives rsession's own terminateAllChildren() sweep on exit by
// ignoring SIGTERM, see server.js) instead of spawning a duplicate.
FilePath raiBridgeStateFile()
{
   // raiSessionEndpointPort() reads the launcher-assigned port directly from
   // session options -- unlike s_sessionEndpointListener, it is available
   // before (and regardless of whether) the session endpoint listener has
   // been started, so it is safe to call from ensureBridgeStarted() on a
   // fresh rsession.
   return raiStudioDir().completeChildPath("bridge-" + raiSessionEndpointPort() + ".port");
}

void resetBridgeState()
{
   s_bridgePort = -1;
   s_bridgePid = -1;
   s_bridgeSpawnedByThisSession = false;
   s_bridgeStartMarker.clear();
   s_spawnRequested = false;
}

// A genuinely detached daemon (see spawnDetachedBridge()) is reparented away
// from us on purpose, so we can never wait() on it for an exit status -- pid
// liveness is the only OS-level signal left. Runs on the main thread only
// (never between fork() and exec()), so the usual async-signal-safety
// concerns don't apply here.
#ifdef _WIN32
bool isPidAlive(PidType pid)
{
   if (pid <= 0)
      return false;
   HANDLE hProcess = ::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                    static_cast<DWORD>(pid));
   if (hProcess == nullptr)
      return false;
   DWORD exitCode = 0;
   bool alive = ::GetExitCodeProcess(hProcess, &exitCode) && exitCode == STILL_ACTIVE;
   ::CloseHandle(hProcess);
   return alive;
}
#else
bool isPidAlive(PidType pid)
{
   if (pid <= 0)
      return false;
   return ::kill(pid, 0) == 0 || errno != ESRCH;
}
#endif

bool readNullSeparatedArguments(const std::string& contents,
                                std::size_t offset,
                                int expectedCount,
                                std::vector<std::string>* pArguments)
{
   pArguments->clear();
   while (offset < contents.size() &&
          (expectedCount < 0 || static_cast<int>(pArguments->size()) < expectedCount))
   {
      while (offset < contents.size() && contents[offset] == '\0')
         ++offset;
      if (offset >= contents.size())
         break;
      const std::size_t end = contents.find('\0', offset);
      if (end == std::string::npos)
         return false;
      pArguments->push_back(contents.substr(offset, end - offset));
      offset = end + 1;
   }
   return expectedCount < 0
      ? !pArguments->empty()
      : static_cast<int>(pArguments->size()) == expectedCount;
}

bool readProcessStartMarker(PidType pid, std::string* pMarker)
{
   pMarker->clear();
   if (pid <= 0)
      return false;

#ifdef __APPLE__
   struct proc_bsdinfo info;
   const int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0,
                                 &info, PROC_PIDTBSDINFO_SIZE);
   if (size != PROC_PIDTBSDINFO_SIZE || info.pbi_uid != ::geteuid())
      return false;
   *pMarker = boost::lexical_cast<std::string>(info.pbi_start_tvsec) + ":" +
      boost::lexical_cast<std::string>(info.pbi_start_tvusec);
   return true;
#elif defined(_WIN32)
   HANDLE process = ::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                  static_cast<DWORD>(pid));
   if (process == nullptr)
      return false;
   FILETIME created, exited, kernel, user;
   const bool ok = ::GetProcessTimes(process, &created, &exited, &kernel, &user);
   ::CloseHandle(process);
   if (!ok)
      return false;
   ULARGE_INTEGER value;
   value.LowPart = created.dwLowDateTime;
   value.HighPart = created.dwHighDateTime;
   *pMarker = boost::lexical_cast<std::string>(value.QuadPart);
   return true;
#else
   std::string statContents;
   const FilePath statFile("/proc/" + boost::lexical_cast<std::string>(pid) + "/stat");
   if (core::readStringFromFile(statFile, &statContents))
      return false;
   const std::size_t closingParen = statContents.rfind(')');
   if (closingParen == std::string::npos || closingParen + 2 >= statContents.size())
      return false;
   std::vector<std::string> fields;
   boost::algorithm::split(fields, statContents.substr(closingParen + 2),
                           boost::algorithm::is_any_of(" "),
                           boost::algorithm::token_compress_on);
   if (fields.size() <= 19 || fields[19].empty())
      return false;
   *pMarker = fields[19];
   return true;
#endif
}

bool inspectResetProcessIdentity(PidType pid,
                                 int port,
                                 RaiResetProcessIdentity* pIdentity)
{
   *pIdentity = RaiResetProcessIdentity();
   pIdentity->pid = static_cast<long>(pid);
   pIdentity->alive = isPidAlive(pid);
   pIdentity->portReachable = bridgeReady(port);
   if (!pIdentity->alive || !pIdentity->portReachable)
      return false;
   if (!readProcessStartMarker(pid, &pIdentity->startMarker))
      return false;

#ifdef __APPLE__
   struct proc_bsdinfo bsdInfo;
   const int bsdSize = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0,
                                    &bsdInfo, PROC_PIDTBSDINFO_SIZE);
   if (bsdSize != PROC_PIDTBSDINFO_SIZE || bsdInfo.pbi_uid != ::geteuid())
      return false;

   std::string executable(PROC_PIDPATHINFO_MAXSIZE, '\0');
   const int pathSize = proc_pidpath(pid, &executable[0], executable.size());
   if (pathSize <= 0)
      return false;
   executable.resize(static_cast<std::size_t>(pathSize));
   pIdentity->executablePath = executable;
   pIdentity->workingDirectory = core::system::currentWorkingDir(pid).getAbsolutePath();

   int mib[3] = { CTL_KERN, KERN_PROCARGS2, static_cast<int>(pid) };
   std::size_t argsSize = 0;
   if (::sysctl(mib, 3, nullptr, &argsSize, nullptr, 0) != 0 ||
       argsSize < sizeof(int))
      return false;
   std::string args(argsSize, '\0');
   if (::sysctl(mib, 3, &args[0], &argsSize, nullptr, 0) != 0 ||
       argsSize < sizeof(int))
      return false;
   args.resize(argsSize);
   int argc = 0;
   std::memcpy(&argc, args.data(), sizeof(argc));
   if (argc <= 0)
      return false;
   std::size_t offset = sizeof(argc);
   const std::size_t executableEnd = args.find('\0', offset);
   if (executableEnd == std::string::npos)
      return false;
   offset = executableEnd + 1;
   return readNullSeparatedArguments(args, offset, argc, &pIdentity->arguments);
#elif defined(_WIN32)
   // No safe current-working-directory/argv query exists in this codebase.
   // Fail closed: reset discards state and starts fresh without terminating.
   return false;
#else
   const std::string pidString = boost::lexical_cast<std::string>(pid);
   const FilePath procDir("/proc/" + pidString);
   struct stat procStat;
   if (::stat(procDir.getAbsolutePath().c_str(), &procStat) != 0 ||
       procStat.st_uid != ::geteuid())
      return false;
   const FilePath executable = procDir.completeChildPath("exe");
   if (!executable.isSymlink() || !executable.exists())
      return false;
   pIdentity->executablePath = executable.resolveSymlink().getAbsolutePath();
   pIdentity->workingDirectory = core::system::currentWorkingDir(pid).getAbsolutePath();
   std::string args;
   if (core::readStringFromFile(procDir.completeChildPath("cmdline"), &args))
      return false;
   return readNullSeparatedArguments(args, 0, -1, &pIdentity->arguments);
#endif
}

// Where the daemon's stdout/stderr are redirected (see spawnDetachedBridge())
// now that there is no ProcessCallbacks.onStderr to stream them through.
// Same directory as the state file: a per-user, per-window path, never a
// shared/world-writable tmp location.
FilePath raiBridgeLogFile()
{
   return raiStudioDir().completeChildPath("bridge-" + raiSessionEndpointPort() + ".log");
}

// The onExit-equivalent cleanup for a daemon that can no longer tell us it
// died: forget it and remove its state file so the next ensureBridgeStarted()
// spawns fresh instead of trying to reconnect to a corpse.
void forgetDeadBridge()
{
   FilePath stateFile = raiBridgeStateFile();
   if (stateFile.exists())
   {
      Error removeError = stateFile.remove();
      if (removeError)
         LOG_ERROR(removeError);
   }

   resetBridgeState();
}

void recordBridgeStarted(int port, PidType pid, const std::string& nodePath)
{
   s_bridgePid = pid;
   s_bridgeSpawnedByThisSession = true;
   if (!readProcessStartMarker(pid, &s_bridgeStartMarker))
      s_bridgeStartMarker.clear();
   s_bridgeLastStartTime = std::chrono::steady_clock::now();
   s_bridgeLastStderr.clear();

   // Re-persist the state file with the pid, start marker and node path once the pid is known.
   Error writeError = core::writeStringToFile(
      raiBridgeStateFile(),
      formatBridgeStateFile(port, static_cast<long>(pid), s_bridgeStartMarker, nodePath));
   if (writeError)
      LOG_ERROR(writeError);

   LOG_INFO_MESSAGE("RAI bridge started (pid=" +
                    boost::lexical_cast<std::string>(pid) + ")");
}

#ifndef _WIN32

namespace detached_spawn {

// Async-signal-safe close loop that skips one fd (the status pipe's write
// end, which must survive until execve() so a pre-exec failure can still be
// reported). Deliberately NOT core::system's closeFileDescriptorsFrom(): its
// macOS implementation allocates a vector internally, which is unsafe between
// fork() and exec() in a multithreaded process (rsession is one).
void closeExcept(int fdStart, int fdLimit, int keepFd)
{
   for (int fd = fdStart; fd < fdLimit; ++fd)
   {
      if (fd == keepFd)
         continue;
      while (::close(fd) == -1 && errno == EINTR)
      {
      }
   }
}

// Writes exactly sizeof(value) bytes, retrying on EINTR/short writes. Used
// for the pid handoff, where a partial write must never be mistaken for a
// complete one.
bool writeAll(int fd, const void* data, std::size_t len)
{
   const char* p = static_cast<const char*>(data);
   std::size_t written = 0;
   while (written < len)
   {
      ssize_t n = ::write(fd, p + written, len - written);
      if (n == -1)
      {
         if (errno == EINTR)
            continue;
         return false;
      }
      written += static_cast<std::size_t>(n);
   }
   return true;
}

// Reads exactly sizeof(value) bytes, retrying on EINTR. A short/zero read
// (peer closed early) is a failure, not a partial success.
bool readAll(int fd, void* data, std::size_t len)
{
   char* p = static_cast<char*>(data);
   std::size_t got = 0;
   while (got < len)
   {
      ssize_t n = ::read(fd, p + got, len - got);
      if (n == -1)
      {
         if (errno == EINTR)
            continue;
         return false;
      }
      if (n == 0)
         return false; // closed before sending a full pid
      got += static_cast<std::size_t>(n);
   }
   return true;
}

} // namespace detached_spawn

// Spawn server.js as a genuine POSIX daemon: double-forked and setsid()'d so
// it is reparented to init/launchd -- fully outside rsession's process tree
// -- before its own pty child (spawned later, node-side) ever exists. This is
// what actually survives BOTH of rCleanup()'s unconditional sweeps on
// "Restart R" (SessionMain.cpp): terminateAllChildren() only ever reaches
// ProcessSupervisor-tracked children, and this process is never registered
// with it; terminateAllChildProcesses() walks the real OS process tree by
// parent pid starting at rsession, and a genuinely reparented daemon is no
// longer in that tree at all. Neither sweep -- nor the global
// quitChildProcessesOnExit preference they honor -- is touched; this process
// simply becomes invisible to both, the same way any other daemon unrelated
// to rsession already is. Only an explicit hard reset (raiResetBridge(),
// SIGKILL by pid) or a genuine RAI-Studio quit (the Electron layer's
// killRaiBridge(), which finds it by the port it listens on, not by process
// ancestry) can stop it.
//
// argv/envp, the log file, and /dev/null are all opened/built on the heap
// BEFORE forking -- allocating between fork() and exec() is unsafe in a
// multithreaded process, the same caution ProcessSupervisor's own fork path
// already takes (see ChildProcess::run(), PosixChildProcess.cpp). Everything
// executed between fork() and execve() in either child below is restricted to
// async-signal-safe calls for the same reason.
//
// Two pipes carry the handshake back to the (unforked) caller: pidPipe hands
// over the daemon's real pid (there is no ProcessOperations::getPid() for a
// process we never registered with ProcessSupervisor), and statusPipe -- its
// write end marked FD_CLOEXEC -- lets the daemon report a pre-exec setup
// failure explicitly; a successful execve() closes it automatically, so EOF
// with nothing read is the success signal.
Error spawnDetachedBridge(const FilePath& nodePath,
                          const FilePath& bridgeDir,
                          const core::system::Options& environment,
                          const FilePath& logFile,
                          PidType* pPid,
                          const std::string& testCommand = std::string(),
                          const int* testCap = nullptr)
{
   using namespace detached_spawn;

   *pPid = -1;

   std::vector<std::string> argStrings;
   argStrings.push_back(nodePath.getAbsolutePath());
   if (testCommand.empty())
      argStrings.push_back("server.js");
   else
   {
      argStrings.push_back("-c");
      argStrings.push_back(testCommand);
   }
   core::system::ProcessArgs argv(argStrings);

   std::vector<std::string> envStrings;
   for (const core::system::Option& option : environment)
      envStrings.push_back(option.first + "=" + option.second);
   core::system::ProcessArgs envp(envStrings);

   const std::string exePath = nodePath.getAbsolutePath();
   const std::string workDir = bridgeDir.getAbsolutePath();
   const std::string logPath = logFile.getAbsolutePath();

#ifdef __APPLE__
   // Resource limits can be lowered below descriptors that are already open
   int kernelCap = 0;
   size_t capSize = sizeof(kernelCap);
   const int capResult = testCap ? testCap[0] :
      ::sysctlbyname("kern.maxfilesperproc", &kernelCap, &capSize, nullptr, 0);
   if (testCap)
   {
      kernelCap = testCap[1];
      capSize = static_cast<size_t>(testCap[2]);
   }
   // The loop is bounded work, not the inheritance boundary. SETEXEC below
   // closes every unselected fd in the kernel, including fds above a stale cap.
   constexpr int kMaxSupportedFdCap = 1048576;
   const int fdLimit = capResult == 0 && capSize == sizeof(kernelCap) &&
      kernelCap > 0 && kernelCap <= kMaxSupportedFdCap ? kernelCap : 3;

   // Allocate and populate everything in the parent. Darwin's posix_spawn
   // wrapper passes these objects directly to the syscall without allocating.
   struct SpawnSetup
   {
      posix_spawnattr_t attributes{};
      posix_spawn_file_actions_t actions{};
      bool haveAttributes = false, haveActions = false;
      ~SpawnSetup()
      {
         if (haveActions) ::posix_spawn_file_actions_destroy(&actions);
         if (haveAttributes) ::posix_spawnattr_destroy(&attributes);
      }
   } spawnSetup;
   int setupError = ::posix_spawnattr_init(&spawnSetup.attributes);
   spawnSetup.haveAttributes = setupError == 0;
   if (!setupError)
   {
      setupError = ::posix_spawn_file_actions_init(&spawnSetup.actions);
      spawnSetup.haveActions = setupError == 0;
   }
   if (!setupError)
      setupError = ::posix_spawnattr_setflags(&spawnSetup.attributes,
         POSIX_SPAWN_SETEXEC | POSIX_SPAWN_CLOEXEC_DEFAULT);
   for (int fd = STDIN_FILENO; !setupError && fd <= STDERR_FILENO; ++fd)
      setupError = ::posix_spawn_file_actions_addinherit_np(&spawnSetup.actions, fd);
   if (setupError)
      return systemError(setupError, "Cannot launch bridge: cannot prepare safe fd inheritance", ERROR_LOCATION);
#else
   RLimitType soft = 0, hard = 0;
   Error limitError = core::system::getResourceLimit(core::system::FilesLimit, &soft, &hard);
   if (limitError)
      return limitError;
   int fdLimit = (soft == RLIM_INFINITY || soft <= 0 || soft > 65536)
      ? 1024 : static_cast<int>(soft);
#endif

   int devNull = ::open("/dev/null", O_RDONLY);
   if (devNull == -1)
      return systemError(errno, ERROR_LOCATION);

   // O_NOFOLLOW + an ownership/type check below guard against a symlink or
   // pre-existing file planted at this path; the log carries the daemon's
   // stdout/stderr, so it must never be silently redirected somewhere else.
   int log = ::open(logPath.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW,
                    S_IRUSR | S_IWUSR);
   if (log == -1)
   {
      Error error = systemError(errno, ERROR_LOCATION);
      ::close(devNull);
      return error;
   }
   struct stat logStat;
   if (::fstat(log, &logStat) == -1 || !S_ISREG(logStat.st_mode) ||
       logStat.st_uid != ::geteuid())
   {
      ::close(devNull);
      ::close(log);
      return systemError(EACCES, ERROR_LOCATION);
   }

   int pidPipe[2];
   if (::pipe(pidPipe) == -1)
   {
      Error error = systemError(errno, ERROR_LOCATION);
      ::close(devNull);
      ::close(log);
      return error;
   }

   int statusPipe[2];
   if (::pipe(statusPipe) == -1)
   {
      Error error = systemError(errno, ERROR_LOCATION);
      ::close(devNull);
      ::close(log);
      ::close(pidPipe[0]);
      ::close(pidPipe[1]);
      return error;
   }
   // Marked close-on-exec so a SUCCESSFUL execve() in child B closes this end
   // automatically -- that EOF (with nothing read) is what tells the parent
   // the exec actually happened, as opposed to child B merely having reached
   // the point of forking.
   ::fcntl(statusPipe[1], F_SETFD, FD_CLOEXEC);

   PidType childA = ::fork();
   if (childA == -1)
   {
      Error error = systemError(errno, ERROR_LOCATION);
      ::close(devNull);
      ::close(log);
      ::close(pidPipe[0]);
      ::close(pidPipe[1]);
      ::close(statusPipe[0]);
      ::close(statusPipe[1]);
      return error;
   }

   if (childA == 0)
   {
      // First child: leave rsession's session/process group, then fork the
      // real daemon and exit immediately so the daemon is reparented to
      // init/launchd rather than lingering under us as an intermediate
      // process. Only async-signal-safe calls from here to _exit()/execve().
      ::close(pidPipe[0]);
      ::close(statusPipe[0]);

      if (::setsid() == -1)
         ::_exit(126);

      PidType childB = ::fork();
      if (childB == -1)
         ::_exit(126);

      if (childB > 0)
      {
         PidType pid = childB;
         writeAll(pidPipe[1], &pid, sizeof(pid));
         ::close(pidPipe[1]);
         ::close(statusPipe[1]);
         ::_exit(0);
      }

      // childB: the real daemon.
      ::close(pidPipe[1]);

      ::dup2(devNull, STDIN_FILENO);
      ::dup2(log, STDOUT_FILENO);
      ::dup2(log, STDERR_FILENO);
      if (devNull > STDERR_FILENO)
         ::close(devNull);
      if (log > STDERR_FILENO)
         ::close(log);

      if (::chdir(workDir.c_str()) == -1)
      {
         int err = errno;
         writeAll(statusPipe[1], &err, sizeof(err));
         ::_exit(127);
      }

      // Close everything else we may have inherited (e.g. rsession's
      // listening sockets) except the status pipe, which must survive until
      // exec (or a reported failure) below.
      closeExcept(STDERR_FILENO + 1, fdLimit, statusPipe[1]);

      core::system::signal_safe::clearSignalMask();

#ifdef __APPLE__
      // SETEXEC preserves this daemon's pid. Only stdio is inherited; the
      // status writer stays open on failure and closes when exec commits.
      int err = ::posix_spawn(nullptr, exePath.c_str(), &spawnSetup.actions,
                             &spawnSetup.attributes, argv.args(), envp.args());
#else
      ::execve(exePath.c_str(), argv.args(), envp.args());
      int err = errno;
#endif

      // Both exec paths return only on failure.
      writeAll(statusPipe[1], &err, sizeof(err));
      ::_exit(127);
   }

   // Parent (rsession): reap the short-lived first child and recover the
   // daemon's pid and exec status from the handshake pipes.
   ::close(devNull);
   ::close(log);
   ::close(pidPipe[1]);
   ::close(statusPipe[1]);

   int status = 0;
   pid_t waited;
   do
   {
      waited = ::waitpid(childA, &status, 0);
   } while (waited == -1 && errno == EINTR);

   PidType daemonPid = -1;
   bool gotPid = readAll(pidPipe[0], &daemonPid, sizeof(daemonPid));
   ::close(pidPipe[0]);

   int execErrno = 0;
   bool execFailed = readAll(statusPipe[0], &execErrno, sizeof(execErrno));
   ::close(statusPipe[0]);

   if (waited == -1 || !WIFEXITED(status) || WEXITSTATUS(status) != 0)
      return Error(boost::system::errc::make_error_code(boost::system::errc::io_error),
                   "RAI bridge daemonize helper did not exit cleanly", ERROR_LOCATION);

   if (!gotPid || daemonPid <= 0)
      return Error(boost::system::errc::make_error_code(boost::system::errc::io_error),
                   "RAI bridge daemonize handshake did not return a pid", ERROR_LOCATION);

   if (execFailed)
      return systemError(execErrno, ERROR_LOCATION);

   *pPid = daemonPid;
   return Success();
}

#else // _WIN32

// Spawn server.js as a genuinely detached Windows process. DETACHED_PROCESS
// alone is not sufficient: rsession assigns itself into a Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (see initJobObject() in
// Win32System.cpp), and a spawned child inherits its parent's job by default
// unless the job explicitly permits, and the child explicitly requests,
// breakaway. Without CREATE_BREAKAWAY_FROM_JOB the bridge would be silently
// killed the instant rsession exits (Restart R, quit, crash) -- exactly the
// POSIX code's fork/setsid double-fork is designed to avoid. Uses
// core::system::runProgram's ProcessOptions.detachProcess (->
// DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, see Win32ChildProcess.cpp)
// plus breakawayFromJob (-> CREATE_BREAKAWAY_FROM_JOB) together; the pid is
// captured from ProcessResult without waiting for exit via the async
// (non-blocking) start below, not the synchronous convenience overload.
Error spawnDetachedBridge(const FilePath& nodePath,
                          const FilePath& bridgeDir,
                          const core::system::Options& environment,
                          const FilePath& logFile,
                          PidType* pPid)
{
   *pPid = -1;

   std::vector<std::string> args;
   args.push_back("server.js");

   core::system::ProcessOptions options;
   options.workingDir = bridgeDir;
   options.environment = environment;
   options.detachProcess = true;
   options.breakawayFromJob = true;
   options.createNewConsole = false;
   options.redirectStdErrToStdOut = true;

   core::system::ProcessCallbacks callbacks;
   FilePath logFileCopy = logFile;
   callbacks.onStarted = [pPid](core::system::ProcessOperations& operations)
   {
      *pPid = operations.getPid();
   };
   callbacks.onStdout = [logFileCopy](core::system::ProcessOperations&,
                                       const std::string& output)
   {
      Error appendError = core::appendToFile(logFileCopy, output);
      if (appendError)
         LOG_ERROR(appendError);
   };
   callbacks.onExit = [](int /*exitStatus*/) {};

   // A private, local ProcessSupervisor -- never the shared
   // module_context::processSupervisor() singleton. SessionMain.cpp's
   // terminateAllChildren(&module_context::processSupervisor(), ...) sweeps
   // every child tracked by that shared instance; registering the bridge
   // there would defeat the entire point of this function, exactly as the
   // POSIX fork/setsid path above is deliberately never registered with it
   // either. A distinct static instance here is never passed to that sweep,
   // so it stays untouched by design, not by accident. CREATE_BREAKAWAY_FROM_JOB
   // (via breakawayFromJob above) is what makes the underlying OS process
   // itself survive rsession.exe's own exit; this local supervisor merely
   // needs to exist long enough to launch it and hand back the pid.
   //
   // runProgram() only calls ChildProcess::run() synchronously (which itself
   // performs CreateProcessW synchronously and captures the real OS pid) --
   // it does NOT invoke ProcessCallbacks::onStarted, which per Process.hpp is
   // "called during the first call to poll" only. A single poll() call
   // immediately after run() forces that first pass synchronously (this
   // process is the only child this local supervisor has ever been given,
   // so the poll only ever touches it), which is what actually populates
   // *pPid via onStarted above. No further poll() calls are ever made on
   // this instance: the bridge is meant to be forgotten immediately, exactly
   // like the POSIX daemon is reparented away and never waited on again.
   static core::system::ProcessSupervisor s_bridgeLaunchSupervisor;
   Error error = s_bridgeLaunchSupervisor.runProgram(
      nodePath.getAbsolutePath(), args, options, callbacks);
   if (error)
      return error;
   s_bridgeLaunchSupervisor.poll();

   if (*pPid <= 0)
      return Error(boost::system::errc::make_error_code(boost::system::errc::io_error),
                   "RAI bridge daemonize did not report a pid", ERROR_LOCATION);

   return Success();
}

#endif // _WIN32

// Ensures the session health/console-run/console-result endpoint is up and
// this session is stamped as the owner for the token it hands out. Shared by
// both the embedded bridge (node-pty terminal) and the real-Terminal.app
// launcher -- both need the same token/health URL to authenticate MCP calls
// back into this R session.
Error ensureSessionAuthReady(std::string* pToken, std::string* pHealthUrl)
{
   if (s_sessionEndpointToken.empty())
   {
      // The desktop launcher hands each project window a stable token (and,
      // via raiSessionEndpointPort() above, a stable port) so a long-running
      // external claude/codex session's MCP config keeps working across
      // "Restart R" -- rsession itself is what restarts, not the window.
      // Passed via env (RAI_SESSION_TOKEN), not a --rai-session-token CLI
      // arg, so it never lands in rsession's argv (visible to same-user
      // process inspection) or the launcher's debug log of the full launch
      // command line -- unlike --rai-session-port, this value is a secret.
      // Falls back to a fresh per-launch UUID when none was supplied, e.g.
      // RStudio Server, where there is no persistent window process to own it.
      s_sessionEndpointToken = core::system::getenv("RAI_SESSION_TOKEN");
      if (s_sessionEndpointToken.empty())
         s_sessionEndpointToken = core::system::generateUuid(false);
      else
         core::system::unsetenv("RAI_SESSION_TOKEN");
   }

   Error error = ensureSessionEndpointStarted();
   if (error)
      return error;

   *pToken = s_sessionEndpointToken;
   *pHealthUrl = "http://127.0.0.1:" +
      boost::lexical_cast<std::string>(s_sessionEndpointListener->getLocalEndpoint().port()) +
      "/health";

   core::system::unsetenv("RAI_OWNER_TOKEN");

   LOG_INFO_MESSAGE("Stamping RAI session owner for PID " +
                    boost::lexical_cast<std::string>(core::system::currentProcessId()));

   Error stampError = r::exec::RFunction(".rs.rai.stampOwner").call();
   if (stampError)
      LOG_ERROR(stampError);

   return Success();
}

// Spawn node server.js if it isn't already running. Returns an error tagged
// with a "reason" property of "not_found" when node or the bridge itself is
// missing, so the RPC can distinguish that from "still starting up".
Error ensureBridgeStarted()
{
   // A daemon we already spawned that is reparented away from us can never
   // wait()/callback its own exit -- infer death lazily instead, the next
   // time anything calls in here, from bridgeReady() plus pid liveness.
   if (s_spawnRequested && !bridgeReady(s_bridgePort))
   {
      const double elapsedSecs = std::chrono::duration_cast<std::chrono::duration<double>>(
         std::chrono::steady_clock::now() - s_bridgeLastStartTime).count();
      const bool pidAlive = isPidAlive(s_bridgePid);
      double graceSecs = kRaiBridgeStartupGraceSecs;
      std::string liveStartMarker;
      if (pidAlive && !s_bridgeStartMarker.empty() &&
          readProcessStartMarker(s_bridgePid, &liveStartMarker) &&
          liveStartMarker == s_bridgeStartMarker)
         graceSecs = kRaiBridgeLiveStartupGraceSecs;
      if (!pidAlive || elapsedSecs >= graceSecs)
      {
         if (pidAlive || elapsedSecs < kRaiBridgeRapidExitSecs)
            ++s_bridgeRapidExitCount;
         else
            s_bridgeRapidExitCount = 0;
         s_bridgeLastStderr = readFileTail(raiBridgeLogFile(), kRaiBridgeStderrMaxBytes);
         LOG_INFO_MESSAGE("RAI bridge appears to have died (pid=" +
                          boost::lexical_cast<std::string>(s_bridgePid) + ")");
         forgetDeadBridge();
         // fall through: state file was just removed, crash-loop guard below
         // re-checked, and (if still under the limit) a fresh spawn attempted
      }
   }

   if (s_spawnRequested)
   {
      if (!s_sessionEndpointListener)
      {
         std::string token, healthUrl;
         Error authError = ensureSessionAuthReady(&token, &healthUrl);
         if (authError)
            return authError;
      }
      return Success();
   }

   // A prior rsession in this window may have already started a bridge that
   // is still running (it ignores SIGTERM -- see server.js -- so it survives
   // the terminateAllChildren() sweep that rCleanup() runs unconditionally
   // on every rsession exit, restart included) -- reconnect to it instead of
   // spawning a duplicate.
   FilePath stateFile = raiBridgeStateFile();
   if (stateFile.exists())
   {
      std::string contents;
      Error readError = core::readStringFromFile(stateFile, &contents);
      if (!readError && !contents.empty())
      {
         int persistedPort = -1;
         long persistedPid = -1;
         parseBridgeStateFile(contents, &persistedPort, &persistedPid);

         if (bridgeReady(persistedPort))
         {
            s_bridgePort = persistedPort;
            s_bridgePid = static_cast<PidType>(persistedPid);
            s_spawnRequested = true;

            // Reconnecting skips the spawn path's ensureSessionAuthReady(), so a
            // fresh rsession would otherwise leave s_sessionEndpointToken empty
            // and never start the session endpoint listener -- which then makes
            // refreshBridgeWorkspace() in raiGetBridgeUrl fail (that empty-token
            // failure, propagated, was the v0.1.15 startup regression) and
            // leaves the survivor with no MCP callback channel. Re-arm auth
            // here and return a bind failure to the caller.
            std::string token, healthUrl;
            Error authError = ensureSessionAuthReady(&token, &healthUrl);
            if (authError)
               return authError;

            LOG_INFO_MESSAGE("Reconnected to existing RAI bridge (port=" +
                             boost::lexical_cast<std::string>(persistedPort) + ")");
            return Success();
         }

         // Stale -- the bridge behind this port is gone; clean up and fall
         // through to spawning a fresh one.
         Error removeError = stateFile.remove();
         if (removeError)
            LOG_ERROR(removeError);
      }
   }

   if (s_bridgeRapidExitCount >= kRaiBridgeMaxRapidExits)
   {
      std::string message = "RAI bridge failed to become reachable " +
         boost::lexical_cast<std::string>(s_bridgeRapidExitCount) +
         " times in a row.";

      if (!s_bridgeLastStderr.empty())
      {
         message += " Last error output: " + s_bridgeLastStderr;
      }
      else
      {
         message += " This usually means the bundled node binary or a "
            "native module inside the app was blocked from running -- try "
            "quitting the app and running "
            "'xattr -cr /Applications/RAI-Studio.app' (adjust the path if "
            "installed elsewhere), then reopen it.";
      }

      Error error(
         boost::system::errc::make_error_code(boost::system::errc::protocol_error),
         message,
         ERROR_LOCATION);
      error.addProperty("reason", "crash_loop");
      return error;
   }

   FilePath nodePath;
   Error nodeError = node_tools::findNode(&nodePath, "rstudio.raiAssistant.nodeBinaryPath");
   if (nodeError)
   {
      Error error(
         boost::system::errc::make_error_code(boost::system::errc::no_such_file_or_directory),
         "Node.js was not found (" + nodeError.getSummary() + ")",
         nodeError,
         ERROR_LOCATION);
      error.addProperty("reason", "not_found");
      return error;
   }

   FilePath bridgeDir = resolveBridgeDir(nodePath);
   FilePath serverJs = bridgeDir.isEmpty() ? FilePath() : bridgeDir.completeChildPath("server.js");
   if (serverJs.isEmpty() || !serverJs.exists())
   {
      Error error(
         boost::system::errc::make_error_code(boost::system::errc::no_such_file_or_directory),
         serverJs.isEmpty() ? std::string("RAI bridge files not found in the application bundle")
                            : "RAI bridge files not found at " + serverJs.getAbsolutePath(),
         ERROR_LOCATION);
      error.addProperty("reason", "not_found");
      return error;
   }

   std::string token, healthUrl;
   Error error = ensureSessionAuthReady(&token, &healthUrl);
   if (error)
      return error;

   int port = -1;
   error = allocatePort(&port);
   if (error)
      return error;

   core::system::Options environment;
   core::system::environment(&environment);
   core::system::setenv(&environment, "RAI_BRIDGE_PORT",
                        boost::lexical_cast<std::string>(port));
   core::system::setenv(&environment, "RAI_UI_PARENT_ORIGIN",
      session::options().programMode() == kSessionProgramModeDesktop ?
         "http://127.0.0.1:" + session::options().wwwPort() : "");
   core::system::setenv(&environment, "RAI_BRIDGE_CWD",
                        raiProjectCwd().getAbsolutePath());
   core::system::setenv(&environment, "RAI_SESSION_HEALTH_URL", healthUrl);
   core::system::setenv(&environment, "RAI_BRIDGE_TOKEN", token);

   PidType daemonPid = -1;
   Error spawnError = spawnDetachedBridge(nodePath, bridgeDir, environment,
                                          raiBridgeLogFile(), &daemonPid);
   if (spawnError)
   {
      resetBridgeState();
      Error wrappedError(
         boost::system::errc::make_error_code(boost::system::errc::io_error),
         "Failed to launch the RAI bridge process (" + spawnError.getSummary() + ")",
         spawnError,
         ERROR_LOCATION);
      wrappedError.addProperty("reason", "not_found");
      return wrappedError;
   }

   s_bridgePort = port;
   s_spawnRequested = true;
   recordBridgeStarted(port, daemonPid, nodePath.getAbsolutePath());

   LOG_INFO_MESSAGE("Launching RAI bridge: " + nodePath.getAbsolutePath() +
                    " server.js (port=" +
                    boost::lexical_cast<std::string>(port) +
                    ", dir=" + bridgeDir.getAbsolutePath() + ")");
   return Success();
}

// Where this window's Terminal.app tab tty is persisted -- keyed by the
// fixed per-window RAI port (see raiSessionEndpointPort()) so it is stable
// across "Restart R" but distinct per project window.
FilePath raiTerminalStateFile()
{
   FilePath dir = core::system::userHomePath().completeChildPath(".raistudio");
   Error error = dir.ensureDirectory();
   if (error)
      LOG_ERROR(error);
   // See raiBridgeStateFile() above -- raiSessionEndpointPort() is safe to
   // call before the session endpoint listener exists; a direct dereference
   // of s_sessionEndpointListener here is not.
   return dir.completeChildPath("terminal-" + raiSessionEndpointPort() + ".tty");
}

// True (and brings it to front) if a Terminal.app tab with this tty still
// exists. A tab's tty is stable for its lifetime and stops matching once the
// tab/window closes -- unlike a tab's *title*, which a launched CLI is free
// to overwrite with its own (claude renames its tab to "Claude Code"), which
// would otherwise break tag matching on the very first launch.
bool focusTerminalTabByTty(const std::string& tty, Error* pError)
{
   std::vector<std::string> args = {
      "-e", "on run argv",
      "-e", "set wantedTty to item 1 of argv",
      "-e", "set result_ to \"not_found\"",
      "-e", "tell application \"Terminal\"",
      "-e", "repeat with w in windows",
      "-e", "repeat with t in tabs of w",
      "-e", "try",
      "-e", "if (tty of t) is wantedTty then",
      "-e", "activate",
      "-e", "set index of w to 1",
      "-e", "set selected tab of w to t",
      "-e", "set result_ to \"found\"",
      "-e", "end if",
      "-e", "end try",
      "-e", "end repeat",
      "-e", "end repeat",
      "-e", "end tell",
      "-e", "return result_",
      "-e", "end run",
      tty
   };

   core::system::ProcessOptions options;
   core::system::ProcessResult result;
   *pError = core::system::runProgram("/usr/bin/osascript", args, "", options, &result);
   if (*pError)
      return false;
   return boost::algorithm::trim_copy(result.stdOut) == "found";
}

// Opens a new Terminal.app tab running scriptPath and reports its tty back
// (the stable per-tab identifier openRealTerminal persists for next time).
Error openNewTerminalTab(const FilePath& scriptPath, std::string* pTty)
{
   // Docks the new window beside RAI-Studio's, matching the user's request
   // to keep the real terminal feeling like part of the same workspace
   // rather than an unrelated floating app window. Best-effort: wrapped in
   // a try block so a renamed/dev-mode process (or a denied Automation
   // permission for System Events) just skips positioning rather than
   // failing the whole launch -- the tab still opens either way. Only done
   // for a newly-created tab, not on every subsequent focus, so it doesn't
   // fight a placement the user has since adjusted by hand.
   std::vector<std::string> args = {
      "-e", "on run argv",
      "-e", "set scriptPath to item 1 of argv",
      "-e", "set ttyPath to \"\"",
      "-e", "tell application \"Terminal\"",
      "-e", "activate",
      "-e", "set newTab to do script (quoted form of scriptPath)",
      "-e", "set ttyPath to tty of newTab",
      "-e", "end tell",
      "-e", "try",
      "-e", "tell application \"System Events\" to tell process \"RAI-Studio\"",
      "-e", "set {rx, ry} to position of window 1",
      "-e", "set {rw, rh} to size of window 1",
      "-e", "end tell",
      "-e", "tell application \"Terminal\" to set bounds of window 1 to {rx + rw, ry, rx + rw + 520, ry + rh}",
      "-e", "end try",
      "-e", "return ttyPath",
      "-e", "end run",
      scriptPath.getAbsolutePath()
   };

   core::system::ProcessOptions options;
   core::system::ProcessResult result;
   Error error = core::system::runProgram("/usr/bin/osascript", args, "", options, &result);
   if (error)
      return error;
   if (result.exitStatus != 0)
   {
      return Error(
         boost::system::errc::make_error_code(boost::system::errc::io_error),
         "Could not open Terminal.app (" + result.stdErr + ")",
         ERROR_LOCATION);
   }
   *pTty = boost::algorithm::trim_copy(result.stdOut);
   return Success();
}

// Opens a new Terminal.app tab running scriptPath and remembers its tty for
// next time. Callers must check focusTerminalTabByTty() against the prior
// tty (via raiTerminalStateFile()) FIRST -- this always opens a new tab
// unconditionally, and generating a fresh MCP config/script just to throw it
// away when an old tab is still live is exactly the bug that lets
// removeStaleSessionConfigs() reap a still-in-use config out from under a
// running session (see ensureTerminalLaunched()).
Error openRealTerminal(const FilePath& scriptPath)
{
   FilePath stateFile = raiTerminalStateFile();

   std::string newTty;
   Error error = openNewTerminalTab(scriptPath, &newTty);
   if (error)
      return error;

   if (!newTty.empty())
   {
      Error writeError = core::writeStringToFile(stateFile, newTty);
      if (writeError)
         LOG_ERROR(writeError);
   }

   return Success();
}

// Opens or focuses a real Terminal.app window running claude/codex -- the
// replacement for the embedded xterm.js/node-pty pane. No node-pty involved:
// a real terminal IS the pty, so this sidesteps the native-module
// code-signing surface that the embedded pane needed.
//
// Desktop-only: there is no persistent per-window launcher process on
// RStudio Server to own a stable token/port, and shelling out to
// /usr/bin/osascript to drive Terminal.app makes no sense against a server
// host's login session anyway.
Error ensureTerminalLaunched()
{
   if (session::options().programMode() != kSessionProgramModeDesktop)
   {
      Error error(
         boost::system::errc::make_error_code(boost::system::errc::not_supported),
         "The RAI Assistant terminal is only available in RStudio Desktop.",
         ERROR_LOCATION);
      error.addProperty("reason", "not_found");
      return error;
   }

   // Re-arm the session endpoint first -- it resets on every "Restart R"
   // even though the token/port stay stable, so a Terminal.app tab left
   // open from before a restart starts working again as soon as this runs.
   std::string token, healthUrl;
   Error error = ensureSessionAuthReady(&token, &healthUrl);
   if (error)
      return error;

   // Fast path: an existing tab from a prior launch is still open. Just
   // focus it -- do NOT regenerate a new MCP config/launch script. That
   // config is still exactly what the running claude/codex process
   // authenticated with (the token/health URL are stable across restarts by
   // design), and regenerating here would immediately orphan it -- worse,
   // the next generate-launch.js invocation's stale-config sweep
   // (mcp.js's removeStaleSessionConfigs(), keyed by the short-lived
   // generator process's own PID) would delete the STILL-IN-USE config out
   // from under the live session, breaking its MCP reconnect.
   FilePath stateFile = raiTerminalStateFile();
   std::string priorTty;
   if (stateFile.exists())
   {
      Error readError = core::readStringFromFile(stateFile, &priorTty);
      if (readError)
         LOG_ERROR(readError);
   }
   priorTty = boost::algorithm::trim_copy(priorTty);

   if (!priorTty.empty())
   {
      Error focusError;
      if (focusTerminalTabByTty(priorTty, &focusError))
         return Success();
      if (focusError)
         LOG_ERROR(focusError);
   }

   // No existing tab (or it's gone) -- generate a fresh MCP config/launch
   // script and open a new one.
   FilePath nodePath;
   Error nodeError = node_tools::findNode(&nodePath, "rstudio.raiAssistant.nodeBinaryPath");
   if (nodeError)
   {
      Error notFoundError(
         boost::system::errc::make_error_code(boost::system::errc::no_such_file_or_directory),
         "Node.js was not found (" + nodeError.getSummary() + ")",
         nodeError,
         ERROR_LOCATION);
      notFoundError.addProperty("reason", "not_found");
      return notFoundError;
   }

   FilePath bridgeDir = resolveBridgeDir(nodePath);
   FilePath generateLaunchJs = bridgeDir.isEmpty() ? FilePath() : bridgeDir.completeChildPath("generate-launch.js");
   if (generateLaunchJs.isEmpty() || !generateLaunchJs.exists())
   {
      Error notFoundError(
         boost::system::errc::make_error_code(boost::system::errc::no_such_file_or_directory),
         generateLaunchJs.isEmpty() ? std::string("RAI bridge files not found in the application bundle")
                                    : "RAI bridge files not found at " + generateLaunchJs.getAbsolutePath(),
         ERROR_LOCATION);
      notFoundError.addProperty("reason", "not_found");
      return notFoundError;
   }

   core::system::Options environment;
   core::system::environment(&environment);
   core::system::setenv(&environment, "RAI_BRIDGE_CWD", raiProjectCwd().getAbsolutePath());
   core::system::setenv(&environment, "RAI_SESSION_HEALTH_URL", healthUrl);
   core::system::setenv(&environment, "RAI_BRIDGE_TOKEN", token);

   core::system::ProcessOptions options;
   options.workingDir = bridgeDir;
   options.environment = environment;

   std::vector<std::string> args;
   args.push_back(generateLaunchJs.getAbsolutePath());

   core::system::ProcessResult result;
   error = core::system::runProgram(nodePath.getAbsolutePath(), args, options, &result);
   if (error)
      return error;
   if (result.exitStatus != 0 || result.stdOut.empty())
   {
      Error scriptError(
         boost::system::errc::make_error_code(boost::system::errc::io_error),
         "Could not generate the RAI Assistant launch script" +
            (result.stdErr.empty() ? std::string() : (" (" + result.stdErr + ")")),
         ERROR_LOCATION);
      scriptError.addProperty("reason", "not_found");
      return scriptError;
   }

   FilePath launchScriptPath;
   error = FilePath::tempFilePath("sh", launchScriptPath);
   if (error)
      return error;

   error = core::writeStringToFile(launchScriptPath, result.stdOut);
   if (error)
      return error;

#ifndef _WIN32
   error = launchScriptPath.changeFileMode(core::FileMode::USER_READ_WRITE_EXECUTE);
   if (error)
      return error;
#endif

   return openRealTerminal(launchScriptPath);
}

// rai_open_terminal -> { status: "ok"|"error", message }
Error raiOpenTerminal(const json::JsonRpcRequest& request,
                      json::JsonRpcResponse* pResponse)
{
   json::Object result;

   Error error = ensureTerminalLaunched();
   if (error)
   {
      result["status"] = "error";
      result["message"] = error.getMessage();
      pResponse->setResult(result);
      return Success();
   }

   result["status"] = "ok";
   result["message"] = "";
   pResponse->setResult(result);
   return Success();
}

// Socket bind failures use the platform socket category, so it and the generic category are both compared.
bool raiIsAddressInUse(const Error& error)
{
   const boost::system::error_code socketBusyCode = boost::asio::error::address_in_use;
   const boost::system::error_code genericBusyCode(
      boost::system::errc::address_in_use, boost::system::generic_category());
   return error == socketBusyCode || error == genericBusyCode;
}

// rai_restart_bridge -> { status: "starting"|"not_found"|"error" }
Error raiRestartBridge(const json::JsonRpcRequest& request,
                       json::JsonRpcResponse* pResponse)
{
   json::Object result;

   // The retained bridge is deliberately daemonized and not a ProcessSupervisor
   // child. A soft terminal restart therefore only forgets local session state;
   // ensureBridgeStarted() reconnects to the same live bridge and preserves its
   // provider PTY. Hard reset below is the explicit SIGKILL path.
   const PidType previousPid = s_bridgePid;
   const bool previousSpawned = s_bridgeSpawnedByThisSession;
   const std::string previousStartMarker = s_bridgeStartMarker;
   resetBridgeState();

   Error error = ensureBridgeStarted();
   if (previousSpawned && previousPid > 0 && s_bridgePid == previousPid)
   {
      s_bridgeSpawnedByThisSession = true;
      s_bridgeStartMarker = previousStartMarker;
   }
   const bool failed = error && !raiIsAddressInUse(error);
   result["status"] = failed ? "not_found" : "starting";
   if (failed)
      result["message"] = error.getMessage();
   pResponse->setResult(result);
   return Success();
}

// rai_reset_bridge -> { status: "starting"|"not_found"|"error", message }.
// The hard reset for when the pane, its WebSocket, or the bridge itself is
// wedged and a soft "Restart terminal" (rai_restart_bridge, which only
// re-points at the same still-running survivor) cannot recover it. It SIGKILLs
// the current bridge by pid -- the bridge ignores SIGTERM, so terminate() would
// leave it running -- clears the persisted state and the crash-loop guard, and
// spawns a fresh bridge in the active project directory. It opens no new
// authenticated control channel on the bridge, so it adds no command surface or
// weak auth: a same-user SIGKILL by pid is all it needs.
Error raiResetBridge(const json::JsonRpcRequest& request,
                     json::JsonRpcResponse* pResponse)
{
   // Recover the survivor's pid from the state file too, in case this session
   // only reconnected to it (s_bridgePid is populated at reconnect, but re-read
   // defensively so a reset works even before any raiGetBridgeUrl round-trip).
   long stateFilePid = -1;
   int statePort = -1;
   bool stateParsed = false;
   std::string stateStartMarker, stateNodePath;
   FilePath stateFile = raiBridgeStateFile();
   if (stateFile.exists())
   {
      std::string contents;
      Error readError = core::readStringFromFile(stateFile, &contents);
      if (!readError)
         stateParsed = parseBridgeStateFile(
            contents, &statePort, &stateFilePid, &stateStartMarker, &stateNodePath);
   }

   // Persisted state is corroboration only; a bridge is signaled only after its live identity matches every recorded field.
   long trackedPid = -1L;
   int trackedPort = s_bridgePort;
   std::string expectedStartMarker;
   std::string expectedNodePath;
   if (s_bridgeSpawnedByThisSession)
   {
      trackedPid = static_cast<long>(s_bridgePid);
      expectedStartMarker = s_bridgeStartMarker;
   }
   else if (stateParsed && stateFilePid > 0 && statePort > 0 &&
            !stateStartMarker.empty() && !stateNodePath.empty() &&
            (s_bridgePort <= 0 || statePort == s_bridgePort))
   {
      trackedPid = stateFilePid;
      trackedPort = statePort;
      expectedStartMarker = stateStartMarker;
      expectedNodePath = stateNodePath;
   }
   FilePath nodePath;
   FilePath bridgeDir;
   RaiResetProcessIdentity observed;
   if (stateParsed && trackedPid > 0 && stateFilePid == trackedPid &&
       statePort == trackedPort)
   {
      Error nodeError;
      if (expectedNodePath.empty())
         nodeError = node_tools::findNode(
            &nodePath, "rstudio.raiAssistant.nodeBinaryPath");
      else
         nodePath = FilePath(expectedNodePath);
      if (!nodeError)
      {
         bridgeDir = resolveBridgeDir(nodePath);
         inspectResetProcessIdentity(static_cast<PidType>(trackedPid), statePort, &observed);
      }
   }

   long killTarget = raiVerifiedResetKillTarget(
      trackedPid,
      trackedPort,
      stateFilePid,
      statePort,
      nodePath.getAbsolutePath(),
      bridgeDir.getAbsolutePath(),
      expectedStartMarker,
      observed);

#ifndef _WIN32
   // A live bridge this reset may not signal keeps its state file, or nothing could find it again.
   if (killTarget <= 0 && trackedPid > 0 && isPidAlive(static_cast<PidType>(trackedPid)) &&
       bridgeReady(statePort > 0 ? statePort : s_bridgePort))
   {
      json::Object refused;
      refused["status"] = "error";
      refused["message"] = "The running assistant could not be verified, so it was not stopped. "
         "Nothing was changed. Quit and reopen RAI-Studio to stop it.";
      pResponse->setResult(refused);
      return Success();
   }
#endif

   if (killTarget > 0)
   {
      // Authorization above is the sole process-control boundary. The bridge
      // ignores SIGTERM, so POSIX must use SIGKILL explicitly; Windows
      // terminateProcess() maps to the platform hard-termination primitive.
#ifdef _WIN32
      const RaiResetTerminationPolicy terminationPolicy =
         raiResetTerminationPolicy(killTarget, true);
      if (terminationPolicy == RaiResetTerminationPolicy::WindowsTerminateProcess)
      {
         Error killError = core::system::terminateProcess(
            static_cast<PidType>(killTarget));
         if (killError)
            LOG_ERROR(killError);
      }
#else
      const RaiResetTerminationPolicy terminationPolicy =
         raiResetTerminationPolicy(killTarget, false);
      if (terminationPolicy == RaiResetTerminationPolicy::PosixSigkill)
      {
         Error killError = core::system::killProcess(
            static_cast<PidType>(killTarget), SIGKILL);
         if (killError)
            LOG_ERROR(killError);
      }
#endif
   }

   if (stateFile.exists())
   {
      Error removeError = stateFile.remove();
      if (removeError)
         LOG_ERROR(removeError);
   }

   // Drop the tracked child and bump the generation (so the killed bridge's
   // stale callbacks are ignored), and clear the crash-loop guard so an
   // explicit user reset is always granted a fresh spawn attempt even if the
   // prior bridge had been crash-looping.
   resetBridgeState();
   s_bridgeRapidExitCount = 0;
   s_bridgeLastStderr.clear();

   json::Object result;
   Error error = ensureBridgeStarted();
   const bool failed = error && !raiIsAddressInUse(error);
   result["status"] = failed ? "not_found" : "starting";
   if (failed)
      result["message"] = error.getMessage();
   pResponse->setResult(result);
   return Success();
}

// The UI only ever gets to say "allow this pending request at this scope" or
// "decline it" -- it cannot supply or influence which tool/target gets
// granted. .rs.rai.recordGrant() derives that solely from the pre-stored
// request, so no client-submitted target ever reaches the R broker.
Error raiSubmitApproval(const json::JsonRpcRequest& request,
                        json::JsonRpcResponse* pResponse)
{
   std::string requestId;
   std::string decision;
   std::string scope;
   Error error = json::readParams(request.params, &requestId, &decision,
                                  &scope);
   if (error)
      return error;

   if (requestId.empty() ||
       (decision != "allow" && decision != "decline") ||
       (scope != "once" && scope != "session" && scope != "project"))
      return Error(json::errc::ParamInvalid, ERROR_LOCATION);

   r::sexp::Protect protect;
   SEXP resultSEXP = R_NilValue;
   error = r::exec::RFunction(".rs.rai.recordGrant", requestId, decision, scope)
      .call(&resultSEXP, &protect);
   if (error)
      return error;

   json::Object result;
   std::string status = raiListField(resultSEXP, "status");
   result["status"] = status;
   result["message"] = raiListField(resultSEXP, "message");
   const std::string runId = raiListField(resultSEXP, "run_id");
   if (!runId.empty())
      result["run_id"] = runId;

   if (status == "apply_document")
   {
      result["saved"] = false;
      RaiDocumentEditOutcome outcome = raiApplyDocumentEdit(
         raiListField(resultSEXP, "document_id"),
         raiListField(resultSEXP, "expected_text"),
         raiListField(resultSEXP, "replacement"),
         raiListField(resultSEXP, "context_before"),
         raiListField(resultSEXP, "context_after"),
         raiListField(resultSEXP, "whole_file") == "true",
         raiListField(resultSEXP, "expected_digest"));
      outcome.operationId = requestId;
      SEXP completionSEXP = R_NilValue;
      error = r::exec::RFunction(".rs.rai.completeDocumentEdit", requestId, outcome.applied, outcome.failureReason,
                                 outcome.before.totalLines, outcome.before.blankLines,
                                 outcome.before.fenceCount, outcome.before.chunkParseCount,
                                 outcome.after.totalLines, outcome.after.blankLines,
                                 outcome.after.fenceCount, outcome.after.chunkParseCount, true)
         .call(&completionSEXP, &protect);
      if (error)
      {
         LOG_ERROR(error);
         const bool rolledBack = !outcome.applied || raiRollbackDocumentEdit(outcome);
         result["status"] = "error";
         result["message"] = rolledBack ?
            "document completion failed; native edit rolled back" :
            "document completion failed; source-buffer rollback failed; inspect the open buffer";
         pResponse->setResult(result);
         return Success();
      }
      status = raiListField(completionSEXP, "status");
      result["status"] = status;
      result["message"] = raiListField(completionSEXP, "message");
      if (outcome.applied && status != "applied")
      {
         if (!raiRollbackDocumentEdit(outcome))
            result["message"] = "edit trace failed; source-buffer rollback also failed";
      }
      // Only publish the editor mutation (and its Undo entry) after the
      // durable completion trace succeeded. An error never touches the UI.
      if (outcome.applied && status == "applied" && !raiPublishDocumentEdit(outcome))
      {
         status = "error";
         result["status"] = status;
         result["message"] = "document changed during completion; publication refused";
         r::exec::RFunction(".rs.rai.setDocumentEditOutcome", requestId, "error", false,
                           "document changed during completion; publication refused").call();
      }
      if (outcome.applied && status == "applied")
      {
         RaiDocumentOperation operation; operation.edit = outcome;
         s_raiDocumentOperations.emplace(requestId, operation);
         error = r::exec::RFunction(".rs.rai.setDocumentEditOutcome", requestId, "applying", false,
                                  "Waiting for editor acknowledgement").call();
         result["status"] = "applying"; result["saved"] = false;
      }
      // Audit is only reported when the mutation actually landed -- a failed
      // apply must never assert what the buffer's before/after shape was.
      if (status == "applied")
      {
         json::Object before;
         before["total_lines"] = outcome.before.totalLines;
         before["blank_lines"] = outcome.before.blankLines;
         before["fence_count"] = outcome.before.fenceCount;
         before["chunk_parse_count"] = outcome.before.chunkParseCount;
         json::Object after;
         after["total_lines"] = outcome.after.totalLines;
         after["blank_lines"] = outcome.after.blankLines;
         after["fence_count"] = outcome.after.fenceCount;
         after["chunk_parse_count"] = outcome.after.chunkParseCount;
         result["audit_before"] = before;
         result["audit_after"] = after;
      }
   }

   if (status == "queued" && raiListField(resultSEXP, "enqueue") == "yes")
   {
      int registeredMaxLines = 0;
      if (r::sexp::getNamedListElement(resultSEXP, "max_lines", &registeredMaxLines))
         registeredMaxLines = 0;
      std::string enqueueMessage;
      if (!raiEnqueueRegisteredRun(runId,
                                   raiListField(resultSEXP, "code"),
                                   raiListField(resultSEXP, "code_hash"),
                                   registeredMaxLines,
                                   raiListField(resultSEXP, "proposal_id"),
                                   false,
                                   &enqueueMessage))
      {
         result["status"] = "error";
         result["message"] = enqueueMessage;
      }
   }
   pResponse->setResult(result);
   return Success();
}

// rai_get_bridge_url -> { status: "ready"|"starting"|"not_found", url, message }
Error raiGetBridgeUrl(const json::JsonRpcRequest& request,
                      json::JsonRpcResponse* pResponse)
{
   json::Object result;

   Error error = ensureBridgeStarted();
   if (error)
   {
      // The normal rsession HTTP listener already retries address_in_use
      // across Restart R. The Assistant callback listener uses a second stable
      // per-window port and can hit the same overlap on a project switch.
      // Only a bind collision is transient; never accept or contact the old
      // listener as this session, and never hide a persistently occupied port.
      if (raiIsAddressInUse(error))
      {
         const auto now = std::chrono::steady_clock::now();
         if (s_sessionEndpointBindBusySince.time_since_epoch().count() == 0)
            s_sessionEndpointBindBusySince = now;
         const double elapsedSecs = std::chrono::duration_cast<std::chrono::duration<double>>(
            now - s_sessionEndpointBindBusySince).count();
         if (elapsedSecs < kRaiSessionEndpointBindRetrySecs)
         {
            // The presenter retries "starting" after RAI_RETRY_MS; every
            // attempt creates a fresh listener and rechecks the same port.
            result["status"] = "starting";
            result["url"] = "";
            pResponse->setResult(result);
            return Success();
         }
      }
      else
      {
         s_sessionEndpointBindBusySince = std::chrono::steady_clock::time_point();
      }
      // Missing/crashing node or bridge (or a port occupied past the bound)
      // is an actionable terminal failure, not an endless spinner.
      result["status"] = "not_found";
      result["url"] = "";
      result["message"] = error.getMessage();
      pResponse->setResult(result);
      return Success();
   }
   s_sessionEndpointBindBusySince = std::chrono::steady_clock::time_point();

   bool reachable = bridgeReady(s_bridgePort);
   bool authFailed = false;
   if (reachable)
   {
      // Refresh failure is retryable, but the workspace is not ready yet.
      Error workspaceError = refreshBridgeWorkspace(s_bridgePort, &authFailed);
      if (workspaceError)
      {
         LOG_ERROR(workspaceError);
         reachable = false;
      }
   }

   if (authFailed)
   {
      LOG_INFO_MESSAGE("RAI bridge on port " +
                       boost::lexical_cast<std::string>(s_bridgePort) +
                       " failed peer proof -- treating as an untrusted listener");
      result["status"] = "starting";
      result["url"] = "";
      pResponse->setResult(result);
      return Success();
   }

   const std::string status = raiBridgeUrlStatus(false /*startFailed*/, reachable);
   result["status"] = status;
   result["url"] = (status == "ready") ? formatBridgeUrl(s_bridgePort)
                                        : std::string();

   pResponse->setResult(result);
   return Success();
}

// ~/.raistudio/assistant.json -- the single provider/model config shared with
// the bridge (config.js CONFIG_FILE). The native settings dialog reads and
// writes only provider/model here; the bridge reads it when launching the CLI.
FilePath raiConfigFile()
{
   FilePath dir = core::system::userHomePath().completeChildPath(".raistudio");
   Error error = dir.ensureDirectory();
   if (error)
      LOG_ERROR(error);
   return dir.completeChildPath("assistant.json");
}

// Load the config object, falling back to the built-in defaults when the file
// is missing or unparseable. Never writes -- a read must not mutate; the bridge
// owns creating the file on first launch (config.js loadConfig).
json::Object raiLoadConfig()
{
   FilePath configFile = raiConfigFile();
   if (configFile.exists())
   {
      std::string contents;
      Error error = core::readStringFromFile(configFile, &contents);
      if (!error)
      {
         json::Value value;
         error = value.parse(contents);
         if (!error && value.isObject())
            return value.getObject();
      }
   }

   json::Value defaults;
   Error error = defaults.parse(kRaiDefaultConfigJson);
   if (error)
      LOG_ERROR(error);
   return defaults.isObject() ? defaults.getObject() : json::Object();
}

// Shipped CLI profiles are not taken from the browser. An older assistant.json
// can omit a provider the assistant UI already offers. Copy only the missing
// built-in profile so that save can select it.
void raiEnsureShippedProviders(json::Object* config)
{
   json::Value defaults;
   Error error = defaults.parse(kRaiDefaultConfigJson);
   if (error || !defaults.isObject() || !defaults.getObject().hasMember("providers") ||
       !defaults.getObject()["providers"].isObject())
      return;
   json::Object shipped = defaults.getObject()["providers"].getObject();
   if (!config->hasMember("providers") || !(*config)["providers"].isObject())
   {
      config->insert("providers", shipped);
      return;
   }
   for (auto it = shipped.begin(); it != shipped.end(); ++it)
   {
      const auto member = *it;
      const std::string name = member.getName();
      if (!(*config)["providers"].getObject().hasMember(name))
         (*config)["providers"].getObject().insert(name, member.getValue());
   }
}

// Owner-only copy of unreadable settings bytes, written once under a name from the first 24 digest digits.
Error raiWriteSettingsRecoveryCopy(const FilePath& settingsFile,
                                   const std::string& bytes,
                                   const std::string& revision,
                                   std::string* pBackupPath)
{
   const FilePath backup = settingsFile.getParent().completeChildPath(
      settingsFile.getFilename() + ".recovery-" + revision.substr(0, 24));
   *pBackupPath = backup.getAbsolutePath();
   if (backup.exists())
   {
      std::string existing;
      Error error = core::readStringFromFile(backup, &existing);
      if (error)
         return error;
      if (existing == bytes)
         return Success();
      return Error(
         boost::system::errc::make_error_code(boost::system::errc::file_exists),
         "settings recovery backup collision; original settings were not changed",
         ERROR_LOCATION);
   }
#ifndef _WIN32
   // Written under a temporary name and linked into place, so a failed write never leaves a partial recovery file.
   const std::string tmpPath = backup.getAbsolutePath() + ".tmp-" + boost::lexical_cast<std::string>(::getpid());
   ::unlink(tmpPath.c_str());
   const int fd = ::open(tmpPath.c_str(), O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
   if (fd < 0)
      return systemError(errno, ERROR_LOCATION);
   int failure = 0;
   std::size_t written = 0;
   while (written < bytes.size())
   {
      const ssize_t count = ::write(fd, bytes.data() + written, bytes.size() - written);
      if (count < 0)
      {
         if (errno == EINTR)
            continue;
         failure = errno;
         break;
      }
      written += static_cast<std::size_t>(count);
   }
   if (!failure && ::fsync(fd) != 0)
      failure = errno;
   ::close(fd);
   if (!failure && ::link(tmpPath.c_str(), backup.getAbsolutePath().c_str()) != 0)
      failure = errno;
   ::unlink(tmpPath.c_str());
   if (failure == EEXIST)
   {
      std::string existing;
      Error error = core::readStringFromFile(backup, &existing);
      if (error)
         return error;
      if (existing == bytes)
         return Success();
      return Error(
         boost::system::errc::make_error_code(boost::system::errc::file_exists),
         "settings recovery backup collision; original settings were not changed",
         ERROR_LOCATION);
   }
   if (failure)
      return systemError(failure, ERROR_LOCATION);
   return Success();
#else
   return core::writeStringToFile(backup, bytes, string_utils::LineEndingPassthrough, true, 0, true, true);
#endif
}

// Complete native settings transaction. All IDE UI writes arrive here, not
// through a second modal or a stale bridge-wide whole-file writer. A raw-file
// digest detects stale participating saves; the owner-only advisory lock serializes
// cooperating native processes. Unrelated custom fields survive the merge.
Error handleSettingsRequest(const http::Request& request, http::Response* pResponse)
{
   if (request.method() != "POST")
   { pResponse->setStatusCode(http::status::MethodNotAllowed); return Success(); }
   if (!callbackAuthenticated(request, pResponse))
   { pResponse->setStatusCode(http::status::Unauthorized); return Success(); }
   if (request.body().size() > 256 * 1024)
      return raiBadRequest(pResponse, "settings transaction too large");
   http::Fields fields;
   http::util::parseForm(request.body(), &fields);
   std::map<std::string, std::string> args;
   for (const auto& field : fields)
      if (!args.emplace(field.first, field.second).second)
         return raiBadRequest(pResponse, "duplicate settings transaction field");
   const std::string operation = args["operation"];
   if ((operation == "read" && args.size() != 1) ||
       (operation == "save" && (args.size() != 3 || !args.count("settings") || !args.count("expected_revision"))) ||
       (operation != "read" && operation != "save"))
      return raiBadRequest(pResponse, "invalid settings transaction");
#ifndef _WIN32
   FilePath file = raiConfigFile();
   const std::string lockPath = file.getAbsolutePath() + ".lock";
   int lockFd = ::open(lockPath.c_str(), O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
   if (lockFd < 0) return systemError(errno, ERROR_LOCATION);
   auto closeLock = std::shared_ptr<int>(new int(lockFd), [](int* fd) { ::flock(*fd, LOCK_UN); ::close(*fd); delete fd; });
   const int lockMode = operation == "save" ? LOCK_EX : LOCK_SH;
   bool locked = false;
   for (int attempt = 0; attempt < 5 && !locked; ++attempt)
   {
      locked = ::flock(lockFd, lockMode | LOCK_NB) == 0;
      if (!locked && attempt < 4)
         ::usleep(10000);
   }
   if (!locked)
      return raiBadRequest(pResponse, operation == "save" ? "settings writer busy; nothing saved"
                                                          : "settings busy; try again");
#endif
   // Parse and hash the SAME locked snapshot; corrupt bytes are replaced only by a save quoting their revision.
   std::string bytes;
   const FilePath settingsFile = raiConfigFile();
   Error error;
   if (settingsFile.exists()) {
      error = core::readStringFromFile(settingsFile, &bytes);
      if (error) return error;
   }
   json::Object config;
   bool invalidExisting = false;
   if (settingsFile.exists()) {
      json::Value existing;
      error = existing.parse(bytes);
      if (error || !existing.isObject())
         invalidExisting = true;
      else
         config = existing.getObject();
   } else config = raiLoadConfig();
   std::string revision;
   error = raiSettingsRevision(bytes, &revision);
   if (error) return error;
   std::string recoveryNotice;
   if (invalidExisting)
   {
#ifndef _WIN32
      if (lockMode != LOCK_EX && ::flock(lockFd, LOCK_EX | LOCK_NB) != 0)
         return raiBadRequest(pResponse, "settings busy; try again");
#endif
      std::string backupPath;
      error = raiWriteSettingsRecoveryCopy(settingsFile, bytes, revision, &backupPath);
      if (error) return error;
      config = raiLoadConfig();
      recoveryNotice = "Settings could not be read (not a valid JSON object). Original remains at " +
         settingsFile.getAbsolutePath() + "; backup saved as " + backupPath +
         ". Defaults are temporary; Save in Settings explicitly replaces the invalid file.";
   }
   bool committed = false;
   json::Object result;
   if (operation == "save")
   {
      if (args["expected_revision"] != revision)
      {
         result.insert("status", "conflict");
         result.insert("message", "Settings changed in another window; reload before saving. Draft retained.");
      }
      else
      {
         json::Value value;
         error = value.parse(args["settings"]);
         if (error || !value.isObject()) return raiBadRequest(pResponse, "invalid settings object");
         json::Object next = value.getObject();
         const std::set<std::string> editable = {"provider", "caffeinate", "saveOnEdit", "autoApproveReadOnly", "theme", "fontSize", "globalPrompt", "snippets", "settingsVersion", "model", "effort"};
         // Provider commands/auth profiles are never browser-controlled. Read
         // the current protected profile and copy only the UI's editable fields.
         // Missing shipped profiles (claude, codex, opencode, grok) come from
         // the built-in defaults, not from the request body.
         raiEnsureShippedProviders(&config);
         if (!next.hasMember("provider") || !next["provider"].isString() ||
             !config.hasMember("providers") || !config["providers"].isObject() ||
             !config["providers"].getObject().hasMember(next["provider"].getString()))
            return raiBadRequest(pResponse, "unknown provider; no fallback applied");
         // saveOnEdit is retired: still validated and persisted for older settings UIs, never read. RAI always saves.
         for (const std::string name : {"caffeinate", "saveOnEdit", "autoApproveReadOnly"})
            if (!next.hasMember(name) || !next[name].isBool())
               return raiBadRequest(pResponse, name + " must be boolean");
         if (!next.hasMember("theme") || !next["theme"].isString() ||
             (next["theme"].getString() != "dark" && next["theme"].getString() != "light" &&
              next["theme"].getString() != "system"))
            return raiBadRequest(pResponse, "invalid theme");
         if (!next.hasMember("fontSize") || !next["fontSize"].isInt() ||
             !std::set<int>{10, 12, 14, 16, 18}.count(next["fontSize"].getInt()))
            return raiBadRequest(pResponse, "invalid font size");
         if (!next.hasMember("globalPrompt") || !next["globalPrompt"].isString() ||
             next["globalPrompt"].getString().size() > 16384 ||
             next["globalPrompt"].getString().find('\0') != std::string::npos ||
             next["globalPrompt"].getString().find('\x1b') != std::string::npos)
            return raiBadRequest(pResponse, "invalid global prompt");
         if (!next.hasMember("snippets") || !next["snippets"].isObject())
            return raiBadRequest(pResponse, "invalid snippets");
         json::Object snippets = next["snippets"].getObject();
         if (std::distance(snippets.begin(), snippets.end()) > 5)
            return raiBadRequest(pResponse, "too many snippets");
         for (auto it = snippets.begin(); it != snippets.end(); ++it)
         {
            const auto member = *it;
            if (!member.getValue().isObject()) return raiBadRequest(pResponse, "invalid snippet");
            json::Object item = member.getValue().getObject();
            if (!item.hasMember("name") || !item["name"].isString() || item["name"].getString().empty() ||
                item["name"].getString().size() > 256 || !item.hasMember("prompt") || !item["prompt"].isString() ||
                item["prompt"].getString().empty() || item["prompt"].getString().size() > 16384)
               return raiBadRequest(pResponse, "invalid snippet name/prompt");
         }
         for (const auto& name : editable)
            if (next.hasMember(name)) config.insert(name, next[name]);
         // Rotate even for a no-op Save: an acknowledged request cannot replay
         // against the same raw-file revision. Not browser-controlled.
         config.insert("settingsCommitId", core::system::generateUuid());
         const std::string committedBytes = config.writeFormatted();
#ifndef _WIN32
         // Private temporary file mode is set BEFORE writing any prompt text.
         FilePath temp = raiConfigFile().getParent().completeChildPath(".assistant-" + core::system::generateUuid() + ".tmp");
         int fd = ::open(temp.getAbsolutePath().c_str(), O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
         if (fd < 0) return systemError(errno, ERROR_LOCATION);
         ::close(fd);
         error = core::writeStringToFile(temp, committedBytes, string_utils::LineEndingPassthrough, true, 0, true, true);
         if (!error) error = temp.move(raiConfigFile(), FilePath::MoveDirect, true);
         if (error) { temp.removeIfExists(); return error; }
#else
         error = core::writeStringToFileAtomic(raiConfigFile(), committedBytes, string_utils::LineEndingPassthrough);
         if (error) return error;
#endif
         error = raiSettingsRevision(committedBytes, &revision);
         if (error) return error;
         result.insert("status", "committed");
         committed = true;
      }
   }
   else result.insert("status", "ok");
   if (!recoveryNotice.empty() && !committed)
      config.insert("settingsRecovery", recoveryNotice);
   result.insert("settings", config);
   result.insert("settings_revision", revision);
   result.insert("authority", "native");
   pResponse->setContentType("application/json");
   pResponse->setBody(result.write());
   return Success();
}

// rai_get_settings -> the full ~/.raistudio/assistant.json object, or the
// built-in defaults when no file exists yet.
Error raiGetSettings(const json::JsonRpcRequest& request,
                     json::JsonRpcResponse* pResponse)
{
   pResponse->setResult(raiLoadConfig());
   return Success();
}

// rai_set_settings(provider) -> { status: "ok"|"error", message }.
// Merges only the provider into the existing file so account defaults and
// unrelated settings (including caffeinate) are preserved.
Error raiSetSettings(const json::JsonRpcRequest& request,
                     json::JsonRpcResponse* pResponse)
{
   json::Object result;
   result.insert("status", "error");
   result.insert("message", "Use the unified Settings transaction with a current revision; nothing saved.");
   pResponse->setResult(result);
   return Success();
}

// rai_set_caffeinate(caffeinate) -> { status: "ok"|"error", message }.
// Toolbar toggle. Under the same exclusive lock as the settings transaction,
// flip only the caffeinate boolean. Other fields stay as they are.
Error raiSetCaffeinate(const json::JsonRpcRequest& request,
                       json::JsonRpcResponse* pResponse)
{
   bool caffeinate = false;
   Error error = json::readParams(request.params, &caffeinate);
   if (error)
      return error;
   json::Object result;
#ifndef _WIN32
   FilePath file = raiConfigFile();
   const std::string lockPath = file.getAbsolutePath() + ".lock";
   int lockFd = ::open(lockPath.c_str(), O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
   if (lockFd < 0) return systemError(errno, ERROR_LOCATION);
   auto closeLock = std::shared_ptr<int>(new int(lockFd), [](int* fd) { ::flock(*fd, LOCK_UN); ::close(*fd); delete fd; });
   if (::flock(lockFd, LOCK_EX | LOCK_NB) != 0)
   {
      result.insert("status", "error");
      result.insert("message", "settings writer busy; nothing saved");
      pResponse->setResult(result);
      return Success();
   }
#endif
   std::string bytes;
   const FilePath settingsFile = raiConfigFile();
   json::Object config;
   if (settingsFile.exists())
   {
      error = core::readStringFromFile(settingsFile, &bytes);
      if (error) return error;
      json::Value existing;
      error = existing.parse(bytes);
      if (error || !existing.isObject())
      {
         result.insert("status", "error");
         result.insert("message", "Existing settings invalid; original preserved. Repair before saving.");
         pResponse->setResult(result);
         return Success();
      }
      config = existing.getObject();
   }
   else config = raiLoadConfig();
   config.insert("caffeinate", caffeinate);
   config.insert("settingsCommitId", core::system::generateUuid());
   const std::string committedBytes = config.writeFormatted();
#ifndef _WIN32
   FilePath temp = raiConfigFile().getParent().completeChildPath(".assistant-" + core::system::generateUuid() + ".tmp");
   int fd = ::open(temp.getAbsolutePath().c_str(), O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
   if (fd < 0) return systemError(errno, ERROR_LOCATION);
   ::close(fd);
   error = core::writeStringToFile(temp, committedBytes, string_utils::LineEndingPassthrough, true, 0, true, true);
   if (!error) error = temp.move(raiConfigFile(), FilePath::MoveDirect, true);
   if (error) { temp.removeIfExists(); return error; }
#else
   error = core::writeStringToFileAtomic(raiConfigFile(), committedBytes, string_utils::LineEndingPassthrough);
   if (error) return error;
#endif
   result.insert("status", "ok");
   pResponse->setResult(result);
   return Success();
}

// Retired toggle RPC: reject without writing. Compatibility booleans may still
// round-trip through the revision-bound Settings transaction, but are not policy.
Error raiSetAutoApproveReadOnly(const json::JsonRpcRequest& request,
                                json::JsonRpcResponse* pResponse)
{
   json::Object result;
   result.insert("status", "error");
   result.insert("message", "Use the unified Settings transaction with a current revision; nothing saved.");
   pResponse->setResult(result);
   return Success();
}

SEXP rs_raiExpectWarning(SEXP condition)
{
   if (TYPEOF(condition) != VECSXP || ALTREP(condition) || XLENGTH(condition) > 8) return R_NilValue;
   if (ALTREP(Rf_getAttrib(condition, R_DimSymbol))) return R_NilValue;
   SEXP names = Rf_getAttrib(condition, R_NamesSymbol);
   if (TYPEOF(names) != STRSXP || ALTREP(names)) return R_NilValue;
   std::string message;
   for (R_xlen_t i = 0; i < XLENGTH(condition) && i < XLENGTH(names); ++i)
   {
      if (std::string(CHAR(STRING_ELT(names, i))) != "message") continue;
      SEXP value = VECTOR_ELT(condition, i);
      if (TYPEOF(value) != STRSXP || ALTREP(value) || XLENGTH(value) != 1 || STRING_ELT(value, 0) == NA_STRING) return R_NilValue;
      message = CHAR(STRING_ELT(value, 0));
   }
   boost::mutex::scoped_lock lock(s_captureMutex);
   if (s_captureState == RaiCaptureCapturing && !message.empty() && message.size() <= 2000 && s_captureExpectedWarnings.size() < 64)
      s_captureExpectedWarnings.push_back(message);
   return R_NilValue;
}

SEXP rs_raiExpectError(SEXP condition)
{
   {
      boost::mutex::scoped_lock lock(s_captureMutex);
      if (s_captureState == RaiCaptureCapturing) s_captureExpectedError.clear();
   }
   // Read only bounded, already-materialized native condition data. No dispatch,
   // promises, environments, ALTREP materialization, or arbitrary R evaluation.
   if (TYPEOF(condition) != VECSXP || ALTREP(condition) || XLENGTH(condition) > 8) return R_NilValue;
   if (ALTREP(Rf_getAttrib(condition, R_DimSymbol))) return R_NilValue;
   SEXP names = Rf_getAttrib(condition, R_NamesSymbol);
   if (TYPEOF(names) != STRSXP || ALTREP(names)) return R_NilValue;
   std::string message;
   for (R_xlen_t i = 0; i < XLENGTH(condition) && i < XLENGTH(names); ++i)
   {
      if (STRING_ELT(names, i) == NA_STRING || std::strcmp(CHAR(STRING_ELT(names, i)), "message") != 0) continue;
      SEXP value = VECTOR_ELT(condition, i);
      if (TYPEOF(value) != STRSXP || ALTREP(value) || XLENGTH(value) != 1 ||
          STRING_ELT(value, 0) == NA_STRING || LENGTH(STRING_ELT(value, 0)) > 8000) return R_NilValue;
      message = CHAR(STRING_ELT(value, 0));
   }
   boost::mutex::scoped_lock lock(s_captureMutex);
   if (s_captureState == RaiCaptureCapturing) s_captureExpectedError = message;
   return R_NilValue;
}

SEXP rs_raiObserveCondition(SEXP kindSEXP)
{
   if (ALTREP(kindSEXP)) return R_NilValue;
   const std::string kind = r::sexp::safeAsString(kindSEXP);
   bool active;
   {
      boost::mutex::scoped_lock lock(s_captureMutex);
      active = s_captureState == RaiCaptureCapturing;
      if (active)
      {
         if (kind == "error") s_captureSawError = true;
         else if (kind == "warning") { s_captureSawWarning = true; s_captureSawNonErrorCondition = true; }
         else if (kind == "message") s_captureSawNonErrorCondition = true;
         else if (kind == "output_begin") ++s_captureKnownOutputDepth;
         else if (kind == "output_end" && s_captureKnownOutputDepth > 0) --s_captureKnownOutputDepth;
      }
   }
   return Rf_ScalarLogical(active);
}

#ifdef RSTUDIO_UNIT_TESTS_ENABLED
SEXP rs_raiDocumentEditFixture(SEXP actionSEXP, SEXP idSEXP, SEXP payloadSEXP)
{
   const std::string action = r::sexp::asString(actionSEXP), id = r::sexp::asString(idSEXP),
      payload = r::sexp::asString(payloadSEXP);
   json::Object result;
   if (action == "create")
   {
      boost::shared_ptr<source_database::SourceDocument> document(new source_database::SourceDocument("r_source"));
      Error error = document->setPathAndContents(payload);
      if (!error) { document->setDirty(false); error = source_database::put(document); }
      if (!error)
      {
         std::string digest;
         error = core::system::crypto::sha256Hex(document->contents(), &digest);
         if (!error)
         {
            raiObserveRead("doc:" + document->id(), digest, "", 0, document->contents().size(), document->contents().size());
            auto& token = s_raiReadTokens.at("doc:" + document->id());
            token.diskPath = module_context::resolveAliasedPath(document->path()).getAbsolutePath();
            raiDocumentDiskSnapshot(token.diskPath, &token.diskBytes, &token.diskRevision);
            result["document_id"] = document->id(); result["digest"] = digest;
         }
      }
      if (error) result["error"] = error.getMessage();
   }
   else if (action == "approve")
   {
      json::JsonRpcRequest request; request.params.push_back(id); request.params.push_back("allow"); request.params.push_back("once");
      json::JsonRpcResponse response;
      Error error = raiSubmitApproval(request, &response);
      if (error) result["error"] = error.getMessage();
      else result = response.result().getObject();
   }
   else if (action == "ack")
   {
      result = raiAcknowledgeDocumentEdit(id, true, payload);
      r::exec::RFunction(".rs.rai.setDocumentEditOutcome", id, result["status"].getString(),
         result["saved"].getBool(), result.hasMember("message") ? result["message"].getString() : std::string()).call();
   }
   else if (action == "remove")
   {
      source_database::remove(id); s_raiReadTokens.erase("doc:" + id);
   }
   r::sexp::Protect protect;
   return r::sexp::create(result.write(), &protect);
}
#endif

// Effective policy is fixed; legacy compatibility bytes are neither read nor
// rewritten here. R-side authentication, proposal and run validation remain.
SEXP rs_raiAutoApproveReadOnlyEnabled()
{
   r::sexp::Protect protect;
   return r::sexp::create(true, &protect);
}

SEXP rs_raiOwnerToken()
{
   r::sexp::Protect protect;
   return r::sexp::create(s_sessionEndpointToken, &protect);
}

SEXP rs_raiDocumentReadDigest(SEXP idSEXP)
{
   r::sexp::Protect protect;
   std::string id, current, message;
   boost::shared_ptr<source_database::SourceDocument> document;
   if (TYPEOF(idSEXP) != STRSXP || ALTREP(idSEXP) || XLENGTH(idSEXP) != 1 ||
       STRING_ELT(idSEXP, 0) == NA_STRING || r::sexp::extract(idSEXP, &id) ||
       !raiLoadDocument(id, &document, &message) || raiDocumentIsReadOnly(document) ||
       core::system::crypto::sha256Hex(document->contents(), &current) ||
       !raiHasReadToken("doc:" + id, current, current, "", &message))
      return r::sexp::create(std::string(), &protect);
   return r::sexp::create(current, &protect);
}

SEXP rs_raiWholeFileReadValid(SEXP idSEXP, SEXP digestSEXP, SEXP expectedSEXP)
{
   r::sexp::Protect protect;
   std::string id, digest, expected, current, message;
   bool valid = true;
   for (SEXP value : {idSEXP, digestSEXP, expectedSEXP})
      valid = valid && TYPEOF(value) == STRSXP && !ALTREP(value) && XLENGTH(value) == 1 &&
         STRING_ELT(value, 0) != NA_STRING;
   valid = valid && !r::sexp::extract(idSEXP, &id) && !r::sexp::extract(digestSEXP, &digest) &&
      !r::sexp::extract(expectedSEXP, &expected);
   boost::shared_ptr<source_database::SourceDocument> document;
   valid = valid && raiLoadDocument(id, &document, &message) && !raiDocumentIsReadOnly(document);
   valid = valid && expected.size() <= kRaiMaxDocumentTotalBytes && raiIsBoundedUtf8Text(expected) &&
      expected == document->contents() && !core::system::crypto::sha256Hex(expected, &current) &&
      raiHasReadToken("doc:" + id, digest, current, "", &message);
   return r::sexp::create(valid, &protect);
}

SEXP rs_raiWritePathClass(SEXP pathSEXP, SEXP typeSEXP)
{
   r::sexp::Protect protect;
   std::string path;
   RaiWriteClass kind = RaiWriteClass::kUnknown;
   if (TYPEOF(pathSEXP) == STRSXP && !ALTREP(pathSEXP) && XLENGTH(pathSEXP) == 1 &&
       STRING_ELT(pathSEXP, 0) != NA_STRING && !r::sexp::extract(pathSEXP, &path))
   {
      if (!path.empty()) kind = raiResolvedWritePathClass(path);
      else
      {
         std::string type;
         if (TYPEOF(typeSEXP) == STRSXP && !ALTREP(typeSEXP) && XLENGTH(typeSEXP) == 1 &&
             STRING_ELT(typeSEXP, 0) != NA_STRING && !r::sexp::extract(typeSEXP, &type) &&
             (type == "r_source" || type == kSourceDocumentTypeRMarkdown))
            kind = RaiWriteClass::kCode;
      }
   }
   const std::string value = kind == RaiWriteClass::kCode ? "code" :
      kind == RaiWriteClass::kDeniedData ? "deniedData" :
      kind == RaiWriteClass::kDeniedEnv ? "deniedEnv" : "unknown";
   return r::sexp::create(value, &protect);
}

SEXP rs_raiListDocuments()
{
   std::vector<boost::shared_ptr<source_database::SourceDocument> > documents;
   Error error = source_database::list(&documents);
   if (error)
   {
      LOG_ERROR(error);
      return R_NilValue;
   }

   r::sexp::Protect protect;
   std::vector<std::string> names(documents.size());
   SEXP result = r::sexp::createList(names, &protect);
   for (std::size_t i = 0; i < documents.size(); ++i)
      SET_VECTOR_ELT(result, i, documents[i]->toRObject(&protect, false));

   return result;
}

// Attribute values must be checked before any length or element access
bool raiIsDataFrame(SEXP value)
{
   if (TYPEOF(value) != VECSXP)
      return false;
   SEXP classes = Rf_getAttrib(value, R_ClassSymbol);
   if (ALTREP(classes) || TYPEOF(classes) != STRSXP)
      return false;
   for (R_xlen_t i = 0; i < XLENGTH(classes); ++i)
      if (STRING_ELT(classes, i) != NA_STRING &&
          std::string(CHAR(STRING_ELT(classes, i))) == "data.frame")
         return true;
   return false;
}

// Avoid the row.names getter: it creates ALTREP for ordinary compact row names
R_xlen_t raiDataFrameRows(SEXP value)
{
   if (ALTREP(value) || TYPEOF(value) != VECSXP)
      return -1;
   for (R_xlen_t i = 0; i < XLENGTH(value); ++i)
   {
      SEXP column = VECTOR_ELT(value, i);
      SEXP dims = Rf_getAttrib(column, R_DimSymbol);
      if (ALTREP(dims))
         continue;
      if (TYPEOF(dims) == INTSXP && XLENGTH(dims) > 0)
         return INTEGER(dims)[0];
      if (ALTREP(column))
         continue;
      if (Rf_isVectorAtomic(column))
         return XLENGTH(column);
      // Plain list columns have one element per row; nested frames need row semantics
      SEXP classes = Rf_getAttrib(column, R_ClassSymbol);
      if (ALTREP(classes))
         continue;
      if (TYPEOF(column) == VECSXP && !raiIsDataFrame(column))
         return XLENGTH(column);
   }
   return -1;
}

std::string raiClassSummary(SEXP valueSEXP)
{
   SEXP classSEXP = Rf_getAttrib(valueSEXP, R_ClassSymbol);
   if (ALTREP(classSEXP))
      return "unavailable";
   if (TYPEOF(classSEXP) != STRSXP || XLENGTH(classSEXP) == 0)
      return std::string();

   std::ostringstream classes;
   for (R_xlen_t i = 0; i < XLENGTH(classSEXP); ++i)
   {
      if (i > 0)
         classes << ", ";
      classes << CHAR(STRING_ELT(classSEXP, i));
   }
   return classes.str();
}

// At most this many column names are surfaced per object -- enough for the
// assistant's common "what columns does this have" question without turning
// a wide data.frame's names into an unbounded payload.
const R_xlen_t kRaiMaxColumnNames = 40;

std::string raiColumnNamesSummary(SEXP valueSEXP)
{
   // The names getter checks dimension length even when names are absent
   SEXP dimSEXP = Rf_getAttrib(valueSEXP, R_DimSymbol);
   if (ALTREP(dimSEXP))
      return "unavailable";
   SEXP namesSEXP = Rf_getAttrib(valueSEXP, R_NamesSymbol);
   if (ALTREP(namesSEXP))
      return "unavailable";
   if (TYPEOF(namesSEXP) != STRSXP || XLENGTH(namesSEXP) == 0)
      return std::string();

   std::ostringstream names;
   const R_xlen_t total = XLENGTH(namesSEXP);
   const R_xlen_t shown = std::min(total, kRaiMaxColumnNames);
   for (R_xlen_t i = 0; i < shown; ++i)
   {
      if (i > 0)
         names << ", ";
      SEXP nameSEXP = STRING_ELT(namesSEXP, i);
      names << (nameSEXP == NA_STRING ? "<NA>" : CHAR(nameSEXP));
   }
   if (total > shown)
      names << ", ... [" << (total - shown) << " more]";
   return names.str();
}

std::string raiObjectMetadataSummary(SEXP valueSEXP)
{
   std::ostringstream summary;
   if (raiIsDataFrame(valueSEXP))
   {
      const R_xlen_t rows = raiDataFrameRows(valueSEXP);
      summary << "data.frame: ";
      if (rows < 0) summary << "unavailable";
      else summary << rows;
      summary << " obs. of ";
      if (ALTREP(valueSEXP)) summary << "unavailable";
      else summary << XLENGTH(valueSEXP);
      summary << " variables";

      const std::string columnNames = raiColumnNamesSummary(valueSEXP);
      if (!columnNames.empty())
         summary << " [" << columnNames << "]";
   }
   else
   {
      summary << Rf_type2char(TYPEOF(valueSEXP)) << " object, length ";
      if (ALTREP(valueSEXP)) summary << "unavailable";
      else if (!Rf_isVector(valueSEXP)) summary << "n/a";
      else summary << XLENGTH(valueSEXP);

      // Matrices/arrays: report shape, since "length N" alone hides whether
      // N is a vector or an M x K matrix -- exactly the ambiguity a debugging
      // round-trip needs resolved without an extra dim(x) proposal.
      SEXP dimSEXP = Rf_getAttrib(valueSEXP, R_DimSymbol);
      if (ALTREP(dimSEXP))
         summary << ", dim unavailable";
      else if (TYPEOF(dimSEXP) == INTSXP && XLENGTH(dimSEXP) > 0)
      {
         summary << ", dim ";
         for (R_xlen_t i = 0; i < XLENGTH(dimSEXP); ++i)
         {
            if (i > 0)
               summary << " x ";
            summary << INTEGER(dimSEXP)[i];
         }
      }

      // A plain (non-data.frame) named vector or list: surface its names the
      // same way a data.frame's columns are surfaced above.
      const std::string names = raiColumnNamesSummary(valueSEXP);
      if (!names.empty())
         summary << " [" << names << "]";
   }

   const std::string classes = raiClassSummary(valueSEXP);
   if (!classes.empty())
      summary << "; class: " << classes;

   return summary.str();
}

SEXP rs_raiSafeObjectSummary(SEXP nameSEXP)
{
   if (ALTREP(nameSEXP))
   {
      r::sexp::Protect protect;
      r::sexp::ListBuilder result(&protect);
      result.add("found", false);
      result.add("summary", "<bad argument: deferred string>");
      return r::sexp::create(result, &protect);
   }
   const std::string name = r::sexp::safeAsString(nameSEXP);
   r::sexp::Protect protect;
   r::sexp::ListBuilder result(&protect);

   if (!raiIsValidObjectName(name))
   {
      result.add("found", false);
      result.add("summary", R_NilValue);
      return r::sexp::create(result, &protect);
   }

   const r::sexp::BindingType bindingType = r::sexp::getBindingType(name, R_GlobalEnv);
   if (bindingType == r::sexp::BindingType::Unbound ||
       bindingType == r::sexp::BindingType::Missing)
   {
      result.add("found", false);
      result.add("summary", R_NilValue);
   }
   else if (bindingType == r::sexp::BindingType::ActiveBinding)
   {
      result.add("found", true);
      result.add("summary", "<active binding in .GlobalEnv; value not read>");
   }
   else if (bindingType == r::sexp::BindingType::Promise)
   {
      result.add("found", true);
      result.add("summary", "<delayed binding in .GlobalEnv; value not read>");
   }
   else
   {
      // This retrieval is safe only after the non-evaluating classification
      // above established that the binding is a normal, already-forced value.
      SEXP valueSEXP = r::sexp::getBindingIdentity(name, R_GlobalEnv, bindingType);
      result.add("found", true);
      result.add("summary", raiObjectMetadataSummary(valueSEXP));
   }

   return r::sexp::create(result, &protect);
}

// R's implicit class for an object carrying no class attribute -- what class()
// would report. The raw SEXP type name is not the same thing (a double vector
// is type "double" but class "numeric"), and reporting the type where the
// assistant expects a class is a quietly wrong answer, so translate the cases
// where R itself differs. Reads no element, so it stays value-free.
std::string raiImplicitClass(SEXP valueSEXP)
{
   switch (TYPEOF(valueSEXP))
   {
   case REALSXP:  return "numeric";
   case CLOSXP:
   case BUILTINSXP:
   case SPECIALSXP: return "function";
   default:       return Rf_type2char(TYPEOF(valueSEXP));
   }
}

// Class attribute when the object has one, R's implicit class otherwise.
std::string raiClassOrImplicitClass(SEXP valueSEXP)
{
   const std::string classSummary = raiClassSummary(valueSEXP);
   return classSummary.empty() ? raiImplicitClass(valueSEXP) : classSummary;
}

// Bounded label for one binding, chosen WITHOUT reading the bound value. This
// is the whole safety property of the environment listing: classification comes
// from the binding, not from forcing it.
std::string raiBindingKind(r::sexp::BindingType bindingType)
{
   switch (bindingType)
   {
   case r::sexp::BindingType::ActiveBinding: return "active_binding";
   case r::sexp::BindingType::Promise:       return "promise";
   case r::sexp::BindingType::Normal:        return "value";
   default:                                  return "unbound";
   }
}

// At most this many .GlobalEnv bindings are listed per call. The workspace is
// the user's, but an unbounded name dump is still a payload problem, so the
// listing is capped and reports its own truncation.
const std::size_t kRaiMaxEnvironmentBindings = 100;

// Names, binding kinds, and classes for .GlobalEnv, as three parallel vectors
// the R broker zips into objects. Dot-prefixed bindings are deliberately not
// listed (.Random.seed and friends are session bookkeeping, not user context);
// a caller that genuinely wants one can still name it explicitly, exactly as
// get_debug_info already allows. No value is read for promises or active
// bindings, and nothing here evaluates anything.
SEXP rs_raiEnvironmentBindings()
{
   r::sexp::Protect protect;
   r::sexp::ListBuilder result(&protect);

   std::vector<std::string> allNames;
   Error error = r::sexp::objects(R_GlobalEnv, false /*allNames*/, &allNames);
   if (error)
   {
      LOG_ERROR(error);
      allNames.clear();
   }
   std::sort(allNames.begin(), allNames.end());

   const std::size_t total = allNames.size();
   const std::size_t reported = std::min(total, kRaiMaxEnvironmentBindings);

   std::vector<std::string> names;
   std::vector<std::string> bindings;
   std::vector<std::string> classes;
   for (std::size_t i = 0; i < reported; ++i)
   {
      const std::string& name = allNames[i];
      const r::sexp::BindingType bindingType = r::sexp::getBindingType(name, R_GlobalEnv);

      names.push_back(name);
      bindings.push_back(raiBindingKind(bindingType));

      // Only a normal, already-forced binding has a class worth reporting, and
      // only then is retrieving its identity safe.
      if (bindingType == r::sexp::BindingType::Normal)
      {
         SEXP valueSEXP = r::sexp::getBindingIdentity(name, R_GlobalEnv, bindingType);
         classes.push_back(raiClassOrImplicitClass(valueSEXP));
      }
      else
      {
         classes.push_back(std::string());
      }
   }

   result.add("names", names);
   result.add("bindings", bindings);
   result.add("classes", classes);
   result.add("total_count", static_cast<int>(total));
   result.add("truncated", total > reported);
   return r::sexp::create(result, &protect);
}

// Compare one selected binding with a policy-supplied canonical frame. Read
// binding types first: active getters and delayed promises supply no authority.
SEXP rs_raiRealizedBindingIdentity(SEXP envSEXP, SEXP nameSEXP, SEXP referenceSEXP)
{
   if (TYPEOF(envSEXP) != ENVSXP || TYPEOF(referenceSEXP) != ENVSXP ||
       TYPEOF(nameSEXP) != STRSXP || ALTREP(nameSEXP) || XLENGTH(nameSEXP) != 1 ||
       STRING_ELT(nameSEXP, 0) == NA_STRING)
      return Rf_ScalarLogical(FALSE);

   const std::string name = CHAR(STRING_ELT(nameSEXP, 0));
   if (name.empty() || name.size() > 256)
      return Rf_ScalarLogical(FALSE);

   const auto type = r::sexp::getBindingType(name, envSEXP);
   const auto referenceType = r::sexp::getBindingType(name, referenceSEXP);
   if (type != r::sexp::BindingType::Normal ||
       referenceType != r::sexp::BindingType::Normal)
      return Rf_ScalarLogical(FALSE);

   // Normal includes an already-forced promise. No R callback intervenes
   // between classification and retrieval in the owning session thread.
   SEXP value = r::sexp::getBindingIdentity(name, envSEXP, type);
   SEXP reference = r::sexp::getBindingIdentity(name, referenceSEXP, referenceType);
   const bool sameCallable = value != nullptr && value == reference &&
      (TYPEOF(value) == CLOSXP || TYPEOF(value) == BUILTINSXP || TYPEOF(value) == SPECIALSXP);
   return Rf_ScalarLogical(sameCallable);
}

// Run-boundary evidence for the derived-data trace: every .GlobalEnv binding
// (hidden names included) with an opaque identity token. Nothing is forced:
// the binding type is read first (non-evaluating), a normal binding's token
// is its value's address, a promise's token is its unevaluated expression's
// address, and an active binding is reported only by kind. Tokens are compared
// for equality and never dereferenced. A rebinding changes the token; an
// in-place mutation of a reference object under an unchanged binding does NOT,
// which the R side reports as a stated limitation, not a guarantee.
SEXP rs_raiGlobalBindingSnapshot()
{
   r::sexp::Protect protect;
   r::sexp::ListBuilder result(&protect);

   std::vector<std::string> allNames;
   Error error = r::sexp::objects(R_GlobalEnv, true /*allNames*/, &allNames);
   if (error)
   {
      LOG_ERROR(error);
      return R_NilValue;
   }
   std::sort(allNames.begin(), allNames.end());

   std::vector<std::string> identities;
   identities.reserve(allNames.size());
   for (const std::string& name : allNames)
   {
      const r::sexp::BindingType bindingType = r::sexp::getBindingType(name, R_GlobalEnv);
      std::ostringstream token;
      token << raiBindingKind(bindingType) << ":";
      if (bindingType == r::sexp::BindingType::Normal ||
          bindingType == r::sexp::BindingType::Promise)
         token << static_cast<const void*>(r::sexp::getBindingIdentity(name, R_GlobalEnv, bindingType));
      identities.push_back(token.str());
   }

   result.add("names", allNames);
   result.add("identities", identities);
   return r::sexp::create(result, &protect);
}

// Structured Data-Viewer-shaped detail for ONE named .GlobalEnv object:
// class, dimensions, row/column counts, and column names with their classes.
// Every field is metadata R already holds -- no cell value, no row of data, no
// head()/print()/str() dispatch, and no promise or active binding is forced.
//
// summaryModeSEXP selects the shape: "full" (default, unchanged) keeps every
// field below; "nrow" reports identity/binding/class/row_count only and
// deliberately never builds or returns a column name/class/count -- the point
// of the mode is a caller that only needs "how many rows" without receiving a
// column enumeration it did not ask for.
//
// requestedColumnsSEXP is an independent, optional, bounded set of column
// names (already validated/bounded to 20 by the R broker, mirroring
// object_names). Each is looked up by name only -- never by forcing a value
// beyond what full mode already reads -- so it can resolve a column past the
// kRaiMaxColumnNames listing cap without ever widening the shown list itself.
// A data.frame is looked up by its own column names; a 2-D matrix by
// dimnames(x)[[2]], sharing the matrix's single element class; anything else
// (scalars, vectors with no dimnames, unbound columns) reports found = FALSE
// for every requested name, never a class guess and never a value.
struct RaiMissingSample
{
   bool available = false;
   int rows = 0;
   int missing = 0;
};

// Never evaluate R code, invoke S3 methods or materialize ALTREP. A bounded
// prefix of an already-realized atomic column is metadata, not a full count.
RaiMissingSample raiSampleMissing(SEXP value, R_xlen_t start, R_xlen_t rows)
{
   RaiMissingSample result;
   const SEXPTYPE type = TYPEOF(value);
   if (type != LGLSXP && type != INTSXP && type != REALSXP && type != STRSXP)
      return result;
   if (ALTREP(value) || start < 0 || rows < 0 || start > XLENGTH(value) ||
       rows > XLENGTH(value) - start) return result;
   result.available = true;
   result.rows = static_cast<int>(std::min<R_xlen_t>(rows, 1000));
   for (int i = 0; i < result.rows; ++i)
   {
      const R_xlen_t index = start + i;
      if (type == STRSXP) result.missing += STRING_ELT(value, index) == NA_STRING;
      else if (type == REALSXP) result.missing += ISNAN(REAL(value)[index]);
      else if (type == LGLSXP) result.missing += LOGICAL(value)[index] == NA_LOGICAL;
      else result.missing += INTEGER(value)[index] == NA_INTEGER;
   }
   return result;
}

R_xlen_t raiColumnLength(SEXP column)
{
   return ALTREP(column) || !Rf_isVector(column) ? 0 : XLENGTH(column);
}

SEXP rs_raiDataObjectDetail(SEXP nameSEXP, SEXP summaryModeSEXP, SEXP requestedColumnsSEXP)
{
   if (ALTREP(nameSEXP) || ALTREP(summaryModeSEXP) || ALTREP(requestedColumnsSEXP))
   {
      r::sexp::Protect protect;
      r::sexp::ListBuilder result(&protect);
      result.add("found", false);
      result.add("summary", "<bad argument: deferred string>");
      return r::sexp::create(result, &protect);
   }
   const std::string name = r::sexp::safeAsString(nameSEXP);
   std::string summaryMode = r::sexp::safeAsString(summaryModeSEXP, "full");
   if (!raiIsValidSummaryMode(summaryMode))
      summaryMode = "full";
   const bool nrowMode = summaryMode == "nrow";

   std::vector<std::string> requestedColumns;
   r::sexp::fillVectorString(requestedColumnsSEXP, &requestedColumns);
   if (requestedColumns.size() > 20)
      requestedColumns.resize(20);

   r::sexp::Protect protect;
   r::sexp::ListBuilder result(&protect);

   result.add("name", name);
   if (!raiIsValidObjectName(name))
   {
      result.add("found", false);
      return r::sexp::create(result, &protect);
   }

   const r::sexp::BindingType bindingType = r::sexp::getBindingType(name, R_GlobalEnv);
   if (bindingType == r::sexp::BindingType::Unbound ||
       bindingType == r::sexp::BindingType::Missing)
   {
      result.add("found", false);
      return r::sexp::create(result, &protect);
   }

   result.add("found", true);
   result.add("binding", raiBindingKind(bindingType));
   if (bindingType != r::sexp::BindingType::Normal)
   {
      result.add("summary", bindingType == r::sexp::BindingType::ActiveBinding
         ? "<active binding in .GlobalEnv; value not read>"
         : "<delayed binding in .GlobalEnv; value not read>");
      return r::sexp::create(result, &protect);
   }

   SEXP valueSEXP = r::sexp::getBindingIdentity(name, R_GlobalEnv, bindingType);
   result.add("summary", raiObjectMetadataSummary(valueSEXP));

   std::vector<std::string> classes;
   SEXP classSEXP = Rf_getAttrib(valueSEXP, R_ClassSymbol);
   if (ALTREP(classSEXP))
      classes.push_back("unavailable");
   else if (TYPEOF(classSEXP) == STRSXP)
   {
      for (R_xlen_t i = 0; i < XLENGTH(classSEXP); ++i)
      {
         SEXP entrySEXP = STRING_ELT(classSEXP, i);
         classes.push_back(entrySEXP == NA_STRING ? "<NA>" : CHAR(entrySEXP));
      }
   }
   if (classes.empty())
      classes.push_back(raiImplicitClass(valueSEXP));
   result.add("classes", classes);

   std::vector<std::string> unavailable;
   if (ALTREP(classSEXP)) unavailable.push_back("class");
   std::vector<int> dims;
   std::vector<std::string> columnNames;
   std::vector<std::string> columnClasses;
   std::vector<bool> columnMissingAvailable;
   std::vector<int> columnMissingRows;
   std::vector<int> columnMissingCounts;
   bool columnsTruncated = false;
   SEXP dimSEXP = Rf_getAttrib(valueSEXP, R_DimSymbol);
   if (ALTREP(dimSEXP)) unavailable.push_back("dims");

   // Column-name-keyed lookup tables for the requested_columns pass below.
   // Deferred names leave lookup unavailable rather than falsely absent
   SEXP requestLookupNamesSEXP = R_NilValue;
   std::string requestLookupUniformClass;
   bool requestLookupIsDataFrame = false;

   if (!ALTREP(valueSEXP) && raiIsDataFrame(valueSEXP))
   {
      const R_xlen_t rows = raiDataFrameRows(valueSEXP);

      const R_xlen_t columns = XLENGTH(valueSEXP);
      if (rows >= 0)
      {
         dims.push_back(static_cast<int>(rows));
         dims.push_back(static_cast<int>(columns));
         result.add("row_count", static_cast<int>(rows));
      }
      else
      {
         result.add("row_count", "unavailable");
         unavailable.push_back("dims");
      }

      SEXP namesSEXP = ALTREP(dimSEXP) ? R_NilValue : Rf_getAttrib(valueSEXP, R_NamesSymbol);
      const bool namesUnavailable = ALTREP(dimSEXP) || ALTREP(namesSEXP);
      if (namesUnavailable)
      {
         unavailable.push_back("column_names");
         namesSEXP = R_NilValue;
      }
      requestLookupNamesSEXP = namesSEXP;
      requestLookupIsDataFrame = true;

      if (!nrowMode)
      {
         result.add("column_count", static_cast<int>(columns));
         const R_xlen_t shown = std::min(columns, kRaiMaxColumnNames);
         for (R_xlen_t i = 0; i < shown; ++i)
         {
            SEXP columnNameSEXP = (TYPEOF(namesSEXP) == STRSXP && i < XLENGTH(namesSEXP))
               ? STRING_ELT(namesSEXP, i) : NA_STRING;
            columnNames.push_back(namesUnavailable ? "unavailable" :
               (columnNameSEXP == NA_STRING ? "<NA>" : CHAR(columnNameSEXP)));

            SEXP column = VECTOR_ELT(valueSEXP, i);
            columnClasses.push_back(raiClassOrImplicitClass(column));
            const auto sample = raiSampleMissing(column, 0, raiColumnLength(column));
            columnMissingAvailable.push_back(sample.available);
            columnMissingRows.push_back(sample.rows);
            columnMissingCounts.push_back(sample.missing);
         }
         columnsTruncated = columns > shown;
      }
   }
   else if (!ALTREP(dimSEXP) && TYPEOF(dimSEXP) == INTSXP && XLENGTH(dimSEXP) > 0)
   {
      for (R_xlen_t i = 0; i < XLENGTH(dimSEXP); ++i)
         dims.push_back(INTEGER(dimSEXP)[i]);

      if (XLENGTH(dimSEXP) == 2)
      {
         result.add("row_count", INTEGER(dimSEXP)[0]);

         // A matrix has one element type, so every column shares its class;
         // column names come from dimnames[[2]] when the matrix has them.
         SEXP dimNamesSEXP = Rf_getAttrib(valueSEXP, R_DimNamesSymbol);
         SEXP colNamesSEXP = (!ALTREP(dimNamesSEXP) && TYPEOF(dimNamesSEXP) == VECSXP && XLENGTH(dimNamesSEXP) == 2)
            ? VECTOR_ELT(dimNamesSEXP, 1) : R_NilValue;
         if (ALTREP(dimNamesSEXP) || ALTREP(colNamesSEXP))
         {
            unavailable.push_back("column_names");
            colNamesSEXP = R_NilValue;
         }
         requestLookupNamesSEXP = colNamesSEXP;
         requestLookupUniformClass = raiImplicitClass(valueSEXP);

         if (!nrowMode)
         {
            result.add("column_count", INTEGER(dimSEXP)[1]);
            if (TYPEOF(colNamesSEXP) == STRSXP)
            {
               const R_xlen_t total = XLENGTH(colNamesSEXP);
               const R_xlen_t shown = std::min(total, kRaiMaxColumnNames);
               for (R_xlen_t i = 0; i < shown; ++i)
               {
                  SEXP columnNameSEXP = STRING_ELT(colNamesSEXP, i);
                  columnNames.push_back(columnNameSEXP == NA_STRING ? "<NA>" : CHAR(columnNameSEXP));
                  columnClasses.push_back(requestLookupUniformClass);
                  const auto sample = raiSampleMissing(valueSEXP,
                     i * static_cast<R_xlen_t>(INTEGER(dimSEXP)[0]), INTEGER(dimSEXP)[0]);
                  columnMissingAvailable.push_back(sample.available);
                  columnMissingRows.push_back(sample.rows);
                  columnMissingCounts.push_back(sample.missing);
               }
               columnsTruncated = total > shown;
            }
         }
      }
   }

   if ((ALTREP(classSEXP) || ALTREP(dimSEXP)) && dims.empty() && !raiIsDataFrame(valueSEXP))
      result.add("row_count", "unavailable");
   if (ALTREP(valueSEXP) && raiIsDataFrame(valueSEXP))
   {
      result.add("row_count", "unavailable");
      unavailable.push_back("column_names");
      unavailable.push_back("column_count");
   }
   if (!dims.empty())
      unavailable.erase(std::remove(unavailable.begin(), unavailable.end(), "dims"), unavailable.end());
   result.add("metadata_unavailable", unavailable);

   if (!nrowMode)
   {
      if (!dims.empty())
         result.add("dims", dims);
      result.add("column_names", columnNames);
      result.add("column_classes", columnClasses);
      result.add("column_missing_available", columnMissingAvailable);
      result.add("column_missing_sample_rows", columnMissingRows);
      result.add("column_missing_sample_counts", columnMissingCounts);
      result.add("columns_truncated", columnsTruncated);
   }

   if (!requestedColumns.empty())
   {
      std::vector<std::string> requestNames;
      std::vector<bool> requestFound;
      std::vector<std::string> requestAvailability;
      std::vector<std::string> requestClasses;
      std::vector<bool> requestMissingAvailable;
      std::vector<int> requestMissingRows;
      std::vector<int> requestMissingCounts;

      for (const std::string& requestedName : requestedColumns)
      {
         bool found = false;
         std::string foundClass;
         RaiMissingSample sample;

         if (requestLookupIsDataFrame && TYPEOF(requestLookupNamesSEXP) == STRSXP)
         {
            const R_xlen_t total = std::min(XLENGTH(requestLookupNamesSEXP), XLENGTH(valueSEXP));
            for (R_xlen_t i = 0; i < total; ++i)
            {
               SEXP columnNameSEXP = STRING_ELT(requestLookupNamesSEXP, i);
               if (columnNameSEXP != NA_STRING && requestedName == CHAR(columnNameSEXP))
               {
                  found = true;
                  foundClass = raiClassOrImplicitClass(VECTOR_ELT(valueSEXP, i));
                  SEXP column = VECTOR_ELT(valueSEXP, i);
                  sample = raiSampleMissing(column, 0, raiColumnLength(column));
                  break;
               }
            }
         }
         else if (!requestLookupIsDataFrame && TYPEOF(requestLookupNamesSEXP) == STRSXP)
         {
            const R_xlen_t total = XLENGTH(requestLookupNamesSEXP);
            for (R_xlen_t i = 0; i < total; ++i)
            {
               SEXP columnNameSEXP = STRING_ELT(requestLookupNamesSEXP, i);
               if (columnNameSEXP != NA_STRING && requestedName == CHAR(columnNameSEXP))
               {
                  found = true;
                  foundClass = requestLookupUniformClass;
                  sample = raiSampleMissing(valueSEXP,
                     i * static_cast<R_xlen_t>(INTEGER(dimSEXP)[0]), INTEGER(dimSEXP)[0]);
                  break;
               }
            }
         }

         requestNames.push_back(requestedName);
         requestFound.push_back(found);
         requestAvailability.push_back(std::find(unavailable.begin(), unavailable.end(), "column_names") != unavailable.end() ||
            ((ALTREP(classSEXP) || ALTREP(dimSEXP)) && !requestLookupIsDataFrame &&
             requestLookupUniformClass.empty()) ? "unavailable" : "available");
         requestClasses.push_back(foundClass);
         requestMissingAvailable.push_back(sample.available);
         requestMissingRows.push_back(sample.rows);
         requestMissingCounts.push_back(sample.missing);
      }

      result.add("requested_column_names", requestNames);
      result.add("requested_column_found", requestFound);
      result.add("requested_column_availability", requestAvailability);
      result.add("requested_column_classes", requestClasses);
      result.add("requested_column_missing_available", requestMissingAvailable);
      result.add("requested_column_missing_sample_rows", requestMissingRows);
      result.add("requested_column_missing_sample_counts", requestMissingCounts);
   }

   return r::sexp::create(result, &protect);
}

#ifdef RSTUDIO_UNIT_TESTS_ENABLED
void signCallbackFixture(http::Request* request, const std::string& token)
{
   if (token.empty()) return;
   unsigned char random[32];
   if (RAND_bytes(random, sizeof(random)) != 1) return;
   const std::string nc = peerHex(random, sizeof(random));
   if (RAND_bytes(random, sizeof(random)) != 1) return;
   const std::string nb = peerHex(random, sizeof(random));
   std::string proof;
   if (peerMac("mcp-cb-proof", nc, nb,
       s_sessionEndpointListener ? s_sessionEndpointListener->getLocalEndpoint().port() : 0,
       request->body(), &proof, request->method(), request->uri())) return;
   // Wrong fixture keys must still fail the production gate
   if (token != s_sessionEndpointToken) proof = std::string(64, '0');
   {
      boost::mutex::scoped_lock lock(s_callbackMutex);
      s_callbackFixtureRequests.insert(request);
      s_callbackChallenges.emplace(nb, CallbackChallenge{nc, request->method(), request->uri(),
         std::chrono::steady_clock::now() + std::chrono::seconds(5)});
   }
   request->removeHeader("X-RAI-Bridge-Token");
   request->setHeader("X-RAI-Peer-Nonce", nb);
   request->setHeader("X-RAI-Peer-Proof", proof);
}

TEST(SessionRaiAssistant, C1cGateConsumesNonceAndBindsBody)
{
   const std::string original = s_sessionEndpointToken;
   s_sessionEndpointToken = "s8c-gate-key";
   http::Request request;
   request.setMethod("POST"); request.setUri("/monitor"); request.setBody("run_id=run-fixture");
   signCallbackFixture(&request, s_sessionEndpointToken);
   http::Response response;
   EXPECT_TRUE(verifyCallbackProof(request, &response));
   EXPECT_FALSE(response.headerValue("X-RAI-Peer-Ack").empty());
   EXPECT_FALSE(verifyCallbackProof(request, &response));
   signCallbackFixture(&request, s_sessionEndpointToken);
   request.setBody("run_id=run-altered");
   EXPECT_FALSE(verifyCallbackProof(request, &response));
   request.setBody("run_id=run-fixture");
   EXPECT_FALSE(verifyCallbackProof(request, &response));
   s_sessionEndpointToken = original;
}
TEST(SessionRaiAssistant, C1cGateRejectsBearerAndExpiredProof)
{
   const std::string original = s_sessionEndpointToken;
   s_sessionEndpointToken = "s8c-gate-key";
   http::Request request;
   request.setMethod("GET"); request.setUri("/health");
   http::Response response;
   request.setHeader("X-RAI-Bridge-Token", s_sessionEndpointToken);
   EXPECT_FALSE(verifyCallbackProof(request, &response));
   signCallbackFixture(&request, s_sessionEndpointToken);
   request.setHeader("X-RAI-Bridge-Token", s_sessionEndpointToken);
   EXPECT_FALSE(verifyCallbackProof(request, &response));
   signCallbackFixture(&request, s_sessionEndpointToken);
   {
      boost::mutex::scoped_lock lock(s_callbackMutex);
      s_callbackChallenges.at(request.headerValue("X-RAI-Peer-Nonce")).expires = std::chrono::steady_clock::now();
   }
   EXPECT_FALSE(verifyCallbackProof(request, &response));
   s_sessionEndpointToken = original;
}

TEST(SessionRaiAssistant, C1cRealListener)
{
   const char* root = std::getenv("RAI_C1C_FIXTURE");
   if (!root) return;
   s_sessionEndpointToken = core::system::getenv("RAI_BRIDGE_TOKEN");
   ASSERT_FALSE(s_sessionEndpointToken.empty());
   ASSERT_FALSE(ensureSessionEndpointStarted());
   const FilePath dir(root);
   ASSERT_FALSE(core::writeStringToFile(dir.completePath("ready"),
      "http://127.0.0.1:" + std::to_string(s_sessionEndpointListener->getLocalEndpoint().port()) + "/health"));
   const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(150);
   while (!dir.completePath("done").exists() && std::chrono::steady_clock::now() < deadline)
   {
      if (!dir.completePath("hold").exists()) onBackgroundProcessing(false);
      boost::this_thread::sleep_for(boost::chrono::milliseconds(5));
   }
   EXPECT_TRUE(dir.completePath("done").exists());
}
#endif

} // anonymous namespace

#ifndef _WIN32
core::Error raiSpawnDetachedForTests(const std::string& executable,
                                    const std::string& directory,
                                    const std::string& log, long* pid,
                                    const int* testCap, int probeFd)
{
   PidType child = -1;
   core::system::Options environment;
   const std::string fd = std::to_string(probeFd);
   const std::string command =
      "s0=0; s1=0; s2=0; high=0; "
      "[ -e /dev/fd/0 ] && s0=1; [ -e /dev/fd/1 ] && s1=1; "
      "[ -e /dev/fd/2 ] && s2=1; [ -e /dev/fd/" + fd + " ] && high=1; "
      "extra=0; for f in /dev/fd/*; do "
      "case $f in /dev/fd/0|/dev/fd/1|/dev/fd/2) ;; "
      "*) [ -e \"$f\" ] && extra=1 ;; esac; done; "
      "result=LEAK; "
      "[ $s0$s1$s2$high$extra = 11100 ] && result=CLOSED; "
      "printf '%s fd0=%s fd1=%s fd2=%s fd" + fd + "=%s extra=%s\n' "
      "\"$result\" \"$s0\" \"$s1\" \"$s2\" \"$high\" \"$extra\"";
   core::Error error = spawnDetachedBridge(FilePath(executable), FilePath(directory),
                                         environment, FilePath(log), &child, command, testCap);
   *pid = child;
   return error;
}

void raiCloseDescriptorsForTests(int bound, int keep)
{
   detached_spawn::closeExcept(3, bound, keep);
}
#endif

// Test-only: exercises the exact 405/401/400 gating and JSON body the real
// /viewer endpoint returns, without a live listener or process fixture.
#ifdef RSTUDIO_UNIT_TESTS_ENABLED
void raiSignCallbackForTests(core::http::Request* request, const std::string& token)
{
   signCallbackFixture(request, token);
}
#endif

core::Error raiHandleViewerStateRequestForTests(const core::http::Request& request,
                                                core::http::Response* pResponse)
{
   return handleViewerStateRequest(request, pResponse);
}

core::Error raiHandleConsoleMonitorRequestForTests(const core::http::Request& request,
                                                   core::http::Response* pResponse)
{
   return handleConsoleMonitorRequest(request, pResponse);
}

// Test-only: same for /project_context. The gtest session has no project open,
// which is exactly the case that must never fall back to walking the working
// directory, so this hook covers that decision directly.
core::Error raiHandleProjectContextRequestForTests(const core::http::Request& request,
                                                   core::http::Response* pResponse)
{
   return handleProjectContextRequest(request, pResponse);
}

// Test-only: same posture as the /project_context hook above -- exercises the
// exact 405/401/400/path-escape/binary/oversize gating the real /file
// endpoint applies, without a live listener or on-disk project fixture beyond
// the gtest TempDir the caller sets up.
core::Error raiHandleReadProjectFileRequestForTests(const core::http::Request& request,
                                                    core::http::Response* pResponse)
{
   return handleReadProjectFileRequest(request, pResponse);
}

// Test-only: same posture as the /file hook above -- exercises the
// 405/401/400 method/token/field-shape gating the real /edit endpoint
// applies, without a live listener or a real open document beyond what the
// gtest session's empty source_database naturally provides.
core::Error raiHandleDocumentEditRequestForTests(const core::http::Request& request,
                                                 core::http::Response* pResponse)
{
   return handleDocumentEditRequest(request, pResponse);
}

core::Error raiSettingsRevision(const std::string& bytes, std::string* revision)
{
   return core::system::crypto::sha256Hex(bytes, revision);
}

std::string formatBridgeUrl(int port)
{
   return "http://127.0.0.1:" + boost::lexical_cast<std::string>(port) + "/";
}

std::string formatBridgeStateFile(int port,
                                  long pid,
                                  const std::string& startMarker,
                                  const std::string& nodePath)
{
   std::string contents = boost::lexical_cast<std::string>(port) + "\n" +
                          boost::lexical_cast<std::string>(pid);
   if (!startMarker.empty() &&
       startMarker.find_first_of("\r\n") == std::string::npos)
   {
      contents += "\n" + startMarker;
      if (!nodePath.empty() && nodePath.find_first_of("\r\n") == std::string::npos)
         contents += "\n" + nodePath;
   }
   return contents;
}

bool parseBridgeStateFile(const std::string& contents,
                          int* pPort,
                          long* pPid,
                          std::string* pStartMarker,
                          std::string* pNodePath)
{
   *pPort = -1;
   *pPid = -1;
   if (pStartMarker) pStartMarker->clear();
   if (pNodePath) pNodePath->clear();

   std::vector<std::string> rawLines;
   boost::algorithm::split(rawLines, contents,
                           boost::algorithm::is_any_of("\r\n"));

   std::vector<std::string> fields;
   for (const std::string& line : rawLines)
   {
      const std::string trimmed = boost::algorithm::trim_copy(line);
      if (!trimmed.empty())
         fields.push_back(trimmed);
   }

   if (fields.empty())
      return false;

   try
   {
      *pPort = boost::lexical_cast<int>(fields[0]);
   }
   catch (const boost::bad_lexical_cast&)
   {
      *pPort = -1;
      return false;
   }

   // A legacy port-only file (or an unparseable pid) leaves the pid at -1; the
   // port alone is enough to reconnect, just not to SIGKILL by pid.
   if (fields.size() >= 2)
   {
      try
      {
         *pPid = boost::lexical_cast<long>(fields[1]);
      }
      catch (const boost::bad_lexical_cast&)
      {
         *pPid = -1;
      }
   }

   if (fields.size() >= 3 && pStartMarker)
      *pStartMarker = fields[2];
   if (fields.size() >= 4 && pNodePath)
      *pNodePath = fields[3];

   return true;
}

std::string raiBridgeUrlStatus(bool startFailed, bool reachable)
{
   if (startFailed)
      return "not_found";
   return reachable ? "ready" : "starting";
}

long raiVerifiedResetKillTarget(long trackedPid,
                                int trackedPort,
                                long stateFilePid,
                                int stateFilePort,
                                const std::string& expectedExecutablePath,
                                const std::string& expectedBridgeDirectory,
                                const std::string& expectedStartMarker,
                                const RaiResetProcessIdentity& observed)
{
   if (trackedPid <= 0 || stateFilePid <= 0 ||
       trackedPort <= 0 || stateFilePort <= 0 ||
       trackedPid != stateFilePid || trackedPort != stateFilePort ||
       observed.pid != trackedPid || !observed.alive || !observed.portReachable ||
       expectedExecutablePath.empty() || expectedBridgeDirectory.empty() ||
       expectedStartMarker.empty() || observed.startMarker != expectedStartMarker ||
       observed.executablePath != expectedExecutablePath ||
       observed.workingDirectory != expectedBridgeDirectory ||
       observed.arguments.size() != 2 ||
       observed.arguments[0] != expectedExecutablePath ||
       observed.arguments[1] != "server.js")
      return -1;

   return trackedPid;
}

RaiResetTerminationPolicy raiResetTerminationPolicy(long verifiedPid,
                                                     bool isWindows)
{
   if (verifiedPid <= 0)
      return RaiResetTerminationPolicy::None;

   return isWindows
      ? RaiResetTerminationPolicy::WindowsTerminateProcess
      : RaiResetTerminationPolicy::PosixSigkill;
}

Error initialize()
{
   using boost::bind;
   using namespace module_context;

   RS_REGISTER_CALL_METHOD(rs_raiExpectWarning);
   RS_REGISTER_CALL_METHOD(rs_raiExpectError);
   RS_REGISTER_CALL_METHOD(rs_raiObserveCondition);
   RS_REGISTER_CALL_METHOD(rs_raiWritePathClass);
   RS_REGISTER_CALL_METHOD(rs_raiWholeFileReadValid);
   RS_REGISTER_CALL_METHOD(rs_raiDocumentReadDigest);
   RS_REGISTER_CALL_METHOD(rs_raiListDocuments);
   RS_REGISTER_CALL_METHOD(rs_raiSafeObjectSummary);
   RS_REGISTER_CALL_METHOD(rs_raiEnvironmentBindings);
   RS_REGISTER_CALL_METHOD(rs_raiRealizedBindingIdentity);
   RS_REGISTER_CALL_METHOD(rs_raiDataObjectDetail);
   RS_REGISTER_CALL_METHOD(rs_raiAutoApproveReadOnlyEnabled);
   RS_REGISTER_CALL_METHOD(rs_raiOwnerToken);
#ifdef RSTUDIO_UNIT_TESTS_ENABLED
   RS_REGISTER_CALL_METHOD(rs_raiDocumentEditFixture);
#endif
   RS_REGISTER_CALL_METHOD(rs_raiGlobalBindingSnapshot);

   // Commit events, not content hashes: restoring text must not restore identity.
   auto changed = [](boost::shared_ptr<source_database::SourceDocument> doc) { s_raiReadTokens.erase("doc:" + doc->id()); ++s_sourceRevision; ++s_raiDocumentRevisions[doc->id()]; };
   source_database::events().onDocUpdated.connect(changed);
   source_database::events().onDocReopened.connect(changed);
   source_database::events().onDocAdded.connect(changed);
   source_database::events().onDocRenamed.connect([](const std::string&, boost::shared_ptr<source_database::SourceDocument> doc) { s_raiReadTokens.erase("doc:" + doc->id()); ++s_sourceRevision; ++s_raiDocumentRevisions[doc->id()]; });
   source_database::events().onDocRemoved.connect([](const std::string& id, const std::string&) { s_raiReadTokens.erase("doc:" + id); ++s_sourceRevision; ++s_raiDocumentRevisions[id]; });
   source_database::events().onRemoveAll.connect([]() { s_raiReadTokens.clear(); ++s_sourceRevision; for (auto& entry : s_raiDocumentRevisions) ++entry.second; });

   module_context::events().onBackgroundProcessing.connect(onBackgroundProcessing);
   module_context::events().onShutdown.connect(onShutdown);

   // Native Console capture: correlate approved input, accumulate output, and
   // finalize on the next top-level prompt.
   module_context::events().onConsoleInput.connect(onRaiConsoleInput);
   module_context::events().onConsoleOutput.connect(onRaiConsoleOutput);
   module_context::events().onConsolePrompt.connect(onRaiConsolePrompt);

   ExecBlock initBlock;
   initBlock.addFunctions()
      (bind(sourceModuleRFile, "SessionRaiAssistant.R"))
      (bind(registerRpcMethod, "rai_get_bridge_url", raiGetBridgeUrl))
      (bind(registerRpcMethod, "rai_restart_bridge", raiRestartBridge))
      (bind(registerRpcMethod, "rai_reset_bridge", raiResetBridge))
      (bind(registerRpcMethod, "rai_open_terminal", raiOpenTerminal))
      (bind(registerRpcMethod, "rai_get_settings", raiGetSettings))
      (bind(registerRpcMethod, "rai_set_settings", raiSetSettings))
      (bind(registerRpcMethod, "rai_set_caffeinate", raiSetCaffeinate))
      (bind(registerRpcMethod, "rai_set_auto_approve_readonly", raiSetAutoApproveReadOnly))
      (bind(registerRpcMethod, "rai_document_edit_ack", raiDocumentEditAck))
      (bind(registerRpcMethod, "rai_submit_approval", raiSubmitApproval));

   return initBlock.execute();
}

} // namespace rai_assistant
} // namespace modules
} // namespace session
} // namespace rstudio

#ifdef RSTUDIO_UNIT_TESTS_ENABLED
#include "SessionRaiAssistantDocumentTests.inc"
#endif
