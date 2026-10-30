// Native owning-handler regressions. Included only with RSTUDIO_UNIT_TESTS_ENABLED
// so private production handlers need no new exported wrapper or runtime hook.
namespace rstudio { namespace session { namespace modules { namespace rai_assistant {
namespace {
std::size_t s10fixEventCount()
{
   std::vector<ClientEvent> events; clientEventQueue().remove(&events);
   for (const auto& event : events) clientEventQueue().add(event);
   return events.size();
}

Error invokeDocumentProven(Error (*handler)(const http::Request&, http::Response*),
                           http::Request& request, http::Response* response)
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

TEST(SessionRaiAssistant, EnvironmentOpenDocumentReadsPreserveWriterRefusals)
{
   const FilePath database = source_database::path();
   ASSERT_TRUE(database.isWithin(FilePath(core::system::getenv("HOME"))));
   ASSERT_FALSE(database.ensureDirectory());
   // This test requires disposable storage; never populate a live user index.
   ASSERT_EQ(core::system::getenv("HOME"), core::system::getenv("TMPDIR"));
   const FilePath properties = database.getParent().completeChildPath("prop");
   const FilePath propertiesIndex = properties.completeChildPath("INDEX");
   const bool hadIndex = propertiesIndex.exists();
   std::string indexBefore;
   if (hadIndex) ASSERT_FALSE(readStringFromFile(propertiesIndex, &indexBefore));
   std::vector<FilePath> propertiesBefore;
   if (properties.exists()) ASSERT_FALSE(properties.getChildren(propertiesBefore));
   const FilePath root = FilePath(core::system::getenv("TMPDIR")).completeChildPath(core::system::generateUuid(false));
   ASSERT_FALSE(root.ensureDirectory());
   const std::string priorToken = s_sessionEndpointToken;
   BOOST_SCOPE_EXIT_ALL(&) { s_sessionEndpointToken = priorToken; EXPECT_FALSE(root.removeIfExists()); };
   s_sessionEndpointToken = "rai-open-document-unit-token";
   const std::vector<std::pair<std::string, std::string> > cases = {
      {".Rprofile", "r_source"}, {".Renviron", "text"}, {".env", "text"},
      {".env.local", "text"}, {"renv.lock", "json"},
      {"analysis.R", "r_source"}, {"report.Rmd", "r_markdown"}};
   std::vector<FilePath> ownedRecords;
   for (std::size_t index = 0; index < cases.size(); ++index)
   {
      SCOPED_TRACE(cases[index].first);
      boost::shared_ptr<source_database::SourceDocument> document(new source_database::SourceDocument(cases[index].second));
      json::Object metadata; document->writeToJson(&metadata);
      const FilePath fixture = root.completeChildPath(cases[index].first);
      ASSERT_FALSE(writeStringToFile(fixture, "RAI_DUMMY=disk"));
      metadata["path"] = fixture.getAbsolutePath();
      ASSERT_FALSE(document->readFromJson(&metadata));
      const std::string contents = "RAI_DUMMY=" + std::string(65536, 'x');
      document->setContents(contents); document->setDirty(true);
      ownedRecords.push_back(database.completePath(document->id()));
      ownedRecords.push_back(database.completePath(document->id() + "-contents"));
      const FilePath record = ownedRecords[ownedRecords.size() - 2];
      const FilePath sidecar = ownedRecords.back();
      ASSERT_FALSE(record.exists()); ASSERT_FALSE(sidecar.exists());
      BOOST_SCOPE_EXIT_ALL(&) {
         EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists());
      };
      // The reader needs native record/sidecar bytes, not durable properties.
      // Register cleanup before any write, including a partially failed write.
      ASSERT_FALSE(document->writeToFile(record));
      http::Request request; request.setMethod("POST"); request.setUri("/document");
      request.setHeader("X-RAI-Bridge-Token", s_sessionEndpointToken);
      request.setBody("document_id=" + document->id());
      http::Response response;
      ASSERT_FALSE(invokeDocumentProven(handleOpenDocumentRequest, request, &response));
      const bool readable = index >= 4;
      EXPECT_EQ(readable ? 200 : 400, response.statusCode());
      if (!readable) EXPECT_EQ(std::string::npos, response.body().find("RAI_DUMMY"));
      if (response.statusCode() == 200)
      {
         json::Object payload; ASSERT_FALSE(payload.parse(response.body()));
         EXPECT_EQ(contents.substr(0, 65536), payload["contents"].getString());
         EXPECT_EQ(document->id(), payload["document_id"].getString());
         EXPECT_EQ(65536, payload["next_offset"].getInt());
         const std::string digest = payload["content_digest"].getString();
         request.setBody("document_id=" + document->id() + "&offset=65536&expected_digest=" + digest);
         http::Response page; ASSERT_FALSE(invokeDocumentProven(handleOpenDocumentRequest, request, &page));
         ASSERT_EQ(200, page.statusCode());
         json::Object pagePayload; ASSERT_FALSE(pagePayload.parse(page.body()));
         EXPECT_EQ(contents.substr(65536), pagePayload["contents"].getString());
         request.setBody("document_id=" + document->id() + "&offset=65536&expected_digest=" + std::string(64, '0'));
         http::Response stale; ASSERT_FALSE(invokeDocumentProven(handleOpenDocumentRequest, request, &stale));
         EXPECT_EQ(400, stale.statusCode());
      }
      http::Request list; list.setMethod("POST"); list.setUri("/documents"); list.setHeader("X-RAI-Bridge-Token", s_sessionEndpointToken);
      http::Response listed; ASSERT_FALSE(invokeDocumentProven(handleOpenDocumentsRequest, list, &listed));
      if (readable) EXPECT_NE(std::string::npos, listed.body().find(document->id()));
      else EXPECT_EQ(std::string::npos, listed.body().find(document->id()));
      if (index < 5)
      {
         http::Request edit; edit.setMethod("POST"); edit.setUri("/edit"); edit.setHeader("X-RAI-Bridge-Token", s_sessionEndpointToken);
         edit.setBody("document_id=" + document->id() + "&expected_text=RAI_DUMMY&replacement=CHANGED");
         http::Response refused; ASSERT_FALSE(invokeDocumentProven(handleDocumentEditRequest, edit, &refused));
         EXPECT_EQ(400, refused.statusCode());
         EXPECT_FALSE(raiApplyDocumentEdit(document->id(), "RAI_DUMMY", "CHANGED", "", "").applied);
      }
      boost::shared_ptr<source_database::SourceDocument> after(new source_database::SourceDocument());
      ASSERT_FALSE(source_database::get(document->id(), after));
      EXPECT_EQ(contents, after->contents()); EXPECT_TRUE(after->dirty());
      std::string diskContents; ASSERT_FALSE(readStringFromFile(fixture, &diskContents));
      EXPECT_EQ("RAI_DUMMY=disk", diskContents);
      request.setHeader("X-RAI-Bridge-Token", "");
      http::Response unauthorized; ASSERT_FALSE(handleOpenDocumentRequest(request, &unauthorized));
      EXPECT_EQ(401, unauthorized.statusCode());
      EXPECT_EQ(std::string::npos, unauthorized.body().find("RAI_DUMMY"));
   }
   for (const auto& artifact : ownedRecords) EXPECT_FALSE(artifact.exists()) << artifact.getAbsolutePath();
   EXPECT_EQ(hadIndex, propertiesIndex.exists());
   if (hadIndex) { std::string after; ASSERT_FALSE(readStringFromFile(propertiesIndex, &after)); EXPECT_EQ(indexBefore, after); }
   std::vector<FilePath> propertiesAfter;
   if (properties.exists()) ASSERT_FALSE(properties.getChildren(propertiesAfter));
   EXPECT_EQ(propertiesBefore.size(), propertiesAfter.size());
}

TEST(SessionRaiAssistant, EnvironmentOpenDocumentCanonicalPathsKeepInternalStateUnreadable)
{
   const FilePath database = source_database::path();
   ASSERT_TRUE(database.isWithin(FilePath(core::system::getenv("HOME"))));
   ASSERT_FALSE(database.ensureDirectory());
   // This test requires disposable storage; never populate a live user index.
   ASSERT_EQ(core::system::getenv("HOME"), core::system::getenv("TMPDIR"));
   const FilePath properties = database.getParent().completeChildPath("prop");
   const FilePath propertiesIndex = properties.completeChildPath("INDEX");
   const bool hadIndex = propertiesIndex.exists();
   std::string indexBefore;
   if (hadIndex) ASSERT_FALSE(readStringFromFile(propertiesIndex, &indexBefore));
   std::vector<FilePath> propertiesBefore;
   if (properties.exists()) ASSERT_FALSE(properties.getChildren(propertiesBefore));
   const FilePath root = FilePath(core::system::getenv("TMPDIR")).completeChildPath(core::system::generateUuid(false));
   ASSERT_FALSE(root.ensureDirectory());
   const std::string priorToken = s_sessionEndpointToken;
   BOOST_SCOPE_EXIT_ALL(&) { s_sessionEndpointToken = priorToken; EXPECT_FALSE(root.removeIfExists()); };
   s_sessionEndpointToken = "rai-open-document-unit-token";
   const FilePath internal = root.completeChildPath(".raistudio"); ASSERT_FALSE(internal.ensureDirectory());
   ASSERT_FALSE(writeStringToFile(internal.completeChildPath("state.R"), "RAI_DUMMY=internal"));
   ASSERT_FALSE(writeStringToFile(root.completeChildPath(".Renviron"), "RAI_DUMMY=source"));
   ASSERT_FALSE(root.completePath("nested/.RAISTUDIO").ensureDirectory());
   ASSERT_FALSE(writeStringToFile(root.completePath("nested/.RAISTUDIO/state.R"), "RAI_DUMMY=internal"));
   ASSERT_FALSE(writeStringToFile(root.completeChildPath("ordinary.txt"), "RAI_DUMMY=ordinary"));
   std::vector<std::pair<std::string, bool> > cases = {
      {".raistudio/state.R", false}, {"nested/.RAISTUDIO/state.R", false}, {"ordinary.txt", false}};
#ifndef _WIN32
   ASSERT_EQ(0, ::symlink(internal.completeChildPath("state.R").getAbsolutePath().c_str(), root.completeChildPath("internal-alias.R").getAbsolutePath().c_str()));
   ASSERT_EQ(0, ::symlink(root.completeChildPath(".Renviron").getAbsolutePath().c_str(), root.completeChildPath("environment-alias.txt").getAbsolutePath().c_str()));
   ASSERT_EQ(0, ::symlink(root.completeChildPath(".Renviron").getAbsolutePath().c_str(), root.completeChildPath("environment-alias.R").getAbsolutePath().c_str()));
   cases.push_back({"internal-alias.R", false});
   cases.push_back({"environment-alias.txt", false});
   cases.push_back({"environment-alias.R", false});
#endif
   std::vector<FilePath> ownedRecords;
   for (const auto& item : cases)
   {
      SCOPED_TRACE(item.first);
      boost::shared_ptr<source_database::SourceDocument> document(new source_database::SourceDocument(
         boost::algorithm::ends_with(item.first, ".txt") ? "text" : "r_source"));
      json::Object metadata; document->writeToJson(&metadata);
      metadata["path"] = root.completePath(item.first).getAbsolutePath();
      ASSERT_FALSE(document->readFromJson(&metadata)); document->setContents("RAI_DUMMY=buffer");
      ownedRecords.push_back(database.completePath(document->id()));
      ownedRecords.push_back(database.completePath(document->id() + "-contents"));
      const FilePath record = ownedRecords[ownedRecords.size() - 2];
      const FilePath sidecar = ownedRecords.back();
      ASSERT_FALSE(record.exists()); ASSERT_FALSE(sidecar.exists());
      BOOST_SCOPE_EXIT_ALL(&) {
         EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists());
      };
      // The reader needs native record/sidecar bytes, not durable properties.
      // Register cleanup before any write, including a partially failed write.
      ASSERT_FALSE(document->writeToFile(record));
      http::Request request; request.setMethod("POST"); request.setUri("/document"); request.setHeader("X-RAI-Bridge-Token", s_sessionEndpointToken);
      request.setBody("document_id=" + document->id());
      http::Response response; ASSERT_FALSE(invokeDocumentProven(handleOpenDocumentRequest, request, &response));
      EXPECT_EQ(item.second ? 200 : 400, response.statusCode());
      if (!item.second) EXPECT_EQ(std::string::npos, response.body().find("RAI_DUMMY"));
      http::Request edit; edit.setMethod("POST"); edit.setUri("/edit"); edit.setHeader("X-RAI-Bridge-Token", s_sessionEndpointToken);
      edit.setBody("document_id=" + document->id() + "&expected_text=RAI_DUMMY&replacement=CHANGED");
      http::Response refused; ASSERT_FALSE(invokeDocumentProven(handleDocumentEditRequest, edit, &refused));
      EXPECT_EQ(400, refused.statusCode());
      EXPECT_FALSE(raiApplyDocumentEdit(document->id(), "RAI_DUMMY", "CHANGED", "", "").applied);
      std::string diskContents;
      ASSERT_FALSE(readStringFromFile(internal.completeChildPath("state.R"), &diskContents));
      EXPECT_EQ("RAI_DUMMY=internal", diskContents);
      ASSERT_FALSE(readStringFromFile(root.completeChildPath(".Renviron"), &diskContents));
      EXPECT_EQ("RAI_DUMMY=source", diskContents);
   }
   for (const auto& artifact : ownedRecords) EXPECT_FALSE(artifact.exists()) << artifact.getAbsolutePath();
   EXPECT_EQ(hadIndex, propertiesIndex.exists());
   if (hadIndex) { std::string after; ASSERT_FALSE(readStringFromFile(propertiesIndex, &after)); EXPECT_EQ(indexBefore, after); }
   std::vector<FilePath> propertiesAfter;
   if (properties.exists()) ASSERT_FALSE(properties.getChildren(propertiesAfter));
   EXPECT_EQ(propertiesBefore.size(), propertiesAfter.size());
}

TEST(SessionRaiAssistant, ProtectedLocationsStayUnreadableForCodeExtensionOpenDocuments)
{
   const FilePath database = source_database::path();
   ASSERT_TRUE(database.isWithin(FilePath(core::system::getenv("HOME"))));
   ASSERT_FALSE(database.ensureDirectory());
   // This test requires disposable storage; never populate a live user index.
   ASSERT_EQ(core::system::getenv("HOME"), core::system::getenv("TMPDIR"));
   const FilePath root = FilePath(core::system::getenv("TMPDIR")).completeChildPath(core::system::generateUuid(false));
   ASSERT_FALSE(root.ensureDirectory());
   const std::string priorToken = s_sessionEndpointToken;
   BOOST_SCOPE_EXIT_ALL(&) { s_sessionEndpointToken = priorToken; EXPECT_FALSE(root.removeIfExists()); };
   s_sessionEndpointToken = "rai-open-document-unit-token";
   const std::vector<std::pair<std::string, bool> > cases = {
      {"analysis.R", true}, {"credentials.R", false}, {"secret.R", false}, {"secrets/loader.R", false},
      {".claude/hook.sh", false}, {".codex/helper.R", false}, {".grok/run.R", false},
      {"Library/Keychains/x.R", false}, {".config/fish/config.fish", false}, {"repo/.git/hooks/pre-commit", false}};
   std::vector<FilePath> ownedRecords;
   for (const auto& item : cases)
   {
      SCOPED_TRACE(item.first);
      const FilePath fixture = root.completePath(item.first);
      ASSERT_FALSE(fixture.getParent().ensureDirectory());
      ASSERT_FALSE(writeStringToFile(fixture, "RAI_DUMMY=disk"));
      boost::shared_ptr<source_database::SourceDocument> document(new source_database::SourceDocument(
         boost::algorithm::ends_with(item.first, ".R") ? "r_source" : "text"));
      json::Object metadata; document->writeToJson(&metadata);
      metadata["path"] = fixture.getAbsolutePath();
      ASSERT_FALSE(document->readFromJson(&metadata)); document->setContents("RAI_DUMMY=buffer");
      ownedRecords.push_back(database.completePath(document->id()));
      ownedRecords.push_back(database.completePath(document->id() + "-contents"));
      const FilePath record = ownedRecords[ownedRecords.size() - 2];
      const FilePath sidecar = ownedRecords.back();
      ASSERT_FALSE(record.exists()); ASSERT_FALSE(sidecar.exists());
      BOOST_SCOPE_EXIT_ALL(&) {
         EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists());
      };
      ASSERT_FALSE(document->writeToFile(record));
      http::Request request; request.setMethod("POST"); request.setUri("/document"); request.setHeader("X-RAI-Bridge-Token", s_sessionEndpointToken);
      request.setBody("document_id=" + document->id());
      http::Response response; ASSERT_FALSE(invokeDocumentProven(handleOpenDocumentRequest, request, &response));
      EXPECT_EQ(item.second ? 200 : 400, response.statusCode());
      if (!item.second) EXPECT_EQ(std::string::npos, response.body().find("RAI_DUMMY"));
      http::Request list; list.setMethod("POST"); list.setUri("/documents"); list.setHeader("X-RAI-Bridge-Token", s_sessionEndpointToken);
      http::Response listed; ASSERT_FALSE(invokeDocumentProven(handleOpenDocumentsRequest, list, &listed));
      if (item.second) EXPECT_NE(std::string::npos, listed.body().find(document->id()));
      else EXPECT_EQ(std::string::npos, listed.body().find(document->id()));
      EXPECT_EQ(item.second, raiIsEligibleDocument(document, true));
   }
   for (const auto& artifact : ownedRecords) EXPECT_FALSE(artifact.exists()) << artifact.getAbsolutePath();
}

TEST(SessionRaiAssistant, MissingBridgeResolvesToAnEmptyPathNotADeveloperPath)
{
   const std::string prior = core::system::getenv("RAI_BRIDGE_DIR");
   BOOST_SCOPE_EXIT_ALL(&) {
      if (prior.empty()) core::system::unsetenv("RAI_BRIDGE_DIR");
      else core::system::setenv("RAI_BRIDGE_DIR", prior);
   };
   core::system::unsetenv("RAI_BRIDGE_DIR");
   EXPECT_TRUE(resolveBridgeDir(FilePath()).isEmpty());
   EXPECT_TRUE(resolveBridgeDir(FilePath("/nonexistent/app/bin/node/bin/node")).isEmpty());
   core::system::setenv("RAI_BRIDGE_DIR", "/opt/example/bridge");
   EXPECT_EQ("/opt/example/bridge", resolveBridgeDir(FilePath()).getAbsolutePath());
}

TEST(SessionRaiAssistant, S10EditDocumentEligibility)
{
   const FilePath database = source_database::path();
   ASSERT_EQ(core::system::getenv("HOME"), core::system::getenv("TMPDIR"));
   ASSERT_FALSE(database.ensureDirectory());
   const FilePath root = FilePath(core::system::getenv("TMPDIR")).completeChildPath(core::system::generateUuid(false));
   ASSERT_FALSE(root.ensureDirectory());
   const std::string prior = s_sessionEndpointToken;
   BOOST_SCOPE_EXIT_ALL(&) { s_sessionEndpointToken = prior; EXPECT_FALSE(root.removeIfExists()); };
   s_sessionEndpointToken = "s10-owning-handler";
   ASSERT_FALSE(root.completeChildPath("data").ensureDirectory());
   ASSERT_FALSE(root.completeChildPath("code").ensureDirectory());
   ASSERT_FALSE(writeStringToFile(root.completePath("code/x.R"), "old"));
   ASSERT_FALSE(writeStringToFile(root.completePath("data/x.R"), "old"));
   ASSERT_FALSE(writeStringToFile(root.completePath("data/source.R"), "old"));
#ifndef _WIN32
   ASSERT_EQ(0, ::symlink(root.completeChildPath("code").getAbsolutePath().c_str(), root.completeChildPath("raw").getAbsolutePath().c_str()));
   ASSERT_EQ(0, ::symlink(root.completeChildPath("code").getAbsolutePath().c_str(), root.completePath("data/back").getAbsolutePath().c_str()));
   ASSERT_EQ(0, ::symlink(root.completePath("data/back").getAbsolutePath().c_str(), root.completeChildPath("chain").getAbsolutePath().c_str()));
   ASSERT_EQ(0, ::symlink(root.completeChildPath("data").getAbsolutePath().c_str(), root.completeChildPath("alias").getAbsolutePath().c_str()));
   ASSERT_EQ(0, ::symlink(root.completePath("data/source.R").getAbsolutePath().c_str(), root.completeChildPath("link.R").getAbsolutePath().c_str()));
   ASSERT_EQ(0, ::link(root.completePath("data/x.R").getAbsolutePath().c_str(), root.completeChildPath("hard.R").getAbsolutePath().c_str()));
   ASSERT_EQ(0, ::symlink(root.completeChildPath("missing.R").getAbsolutePath().c_str(), root.completeChildPath("dangling.R").getAbsolutePath().c_str()));
#endif
   // Only replace the R queue boundary; native load, policy, anchor and apply stay real.
   ASSERT_FALSE(r::exec::executeString(
      "assign('.s10_old_queue', get0('.rs.rai.queueDocumentEdit', envir=as.environment('tools:rstudio'), inherits=FALSE), .GlobalEnv); "
      "assign('.s10_queue_calls', 0L, .GlobalEnv); assign('.rs.rai.queueDocumentEdit', function(...) { .s10_queue_calls <<- .s10_queue_calls + 1L; list(status='applying') }, as.environment('tools:rstudio'))"));
   BOOST_SCOPE_EXIT_ALL(&) {
      EXPECT_FALSE(r::exec::executeString("if (is.null(.s10_old_queue)) rm('.rs.rai.queueDocumentEdit', envir=as.environment('tools:rstudio')) else assign('.rs.rai.queueDocumentEdit', .s10_old_queue, as.environment('tools:rstudio')); rm(list=c('.s10_old_queue','.s10_queue_calls'), envir=.GlobalEnv)"));
   };
   std::vector<std::pair<std::string, bool>> cases = {
      {"x.py",true}, {"x.js",true}, {"x.ts",true}, {"x.c",true}, {"x.cpp",true},
      {"x.sh",true}, {"x.sql",true}, {"x.css",true}, {"x.R",true}, {"x.Rmd",true}, {"x.qmd",true},
      {"data/x.R",false}, {"x.yaml",false}, {"x.csv",false}, {".env",false}, {"x.foo",false}};
#ifndef _WIN32
   cases.insert(cases.end(), {{"chain/x.R",false},{"raw/x.R",false},{"alias/source.R",false},{"link.R",false},{"hard.R",false},{"dangling.R",false}});
#endif
   for (const auto& item : cases)
   {
      SCOPED_TRACE(item.first);
      ASSERT_FALSE(r::exec::executeString(".s10_queue_calls <- 0L"));
      boost::shared_ptr<source_database::SourceDocument> doc(new source_database::SourceDocument(
         boost::algorithm::ends_with(item.first, ".R") ? "r_source" : "text"));
      json::Object meta; doc->writeToJson(&meta); meta["path"] = root.completePath(item.first).getAbsolutePath();
      ASSERT_FALSE(doc->readFromJson(&meta)); doc->setContents("before old after");
      if (item.second)
      {
         ASSERT_FALSE(writeStringToFile(root.completePath(item.first), "before old after"));
         doc->setDirty(false);
      }
      const FilePath record = database.completePath(doc->id()), sidecar = database.completePath(doc->id()+"-contents");
      ASSERT_FALSE(record.exists()); ASSERT_FALSE(sidecar.exists());
      BOOST_SCOPE_EXIT_ALL(&) { EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); };
      ASSERT_FALSE(doc->writeToFile(record));
      if (item.second)
      {
         http::Request read; read.setMethod("POST"); read.setUri("/document");
         read.setHeader("X-RAI-Bridge-Token",s_sessionEndpointToken);
         read.setBody("document_id="+doc->id());
         http::Response response; ASSERT_FALSE(invokeDocumentProven(handleOpenDocumentRequest,read,&response));
         ASSERT_EQ(200,response.statusCode());
      }
      http::Request req; req.setMethod("POST"); req.setUri("/edit"); req.setHeader("X-RAI-Bridge-Token",s_sessionEndpointToken);
      req.setBody("document_id="+doc->id()+"&expected_text=old&replacement=new");
      http::Response response; ASSERT_FALSE(invokeDocumentProven(handleDocumentEditRequest,req,&response));
      if (item.second) EXPECT_EQ(200,response.statusCode()) << response.body();
      else EXPECT_NE(std::string::npos,response.body().find("\"policy\":\"refused\"")) << response.body();
      int queueCalls = -1;
      ASSERT_FALSE(r::exec::RFunction("get", ".s10_queue_calls").call(&queueCalls));
      EXPECT_EQ(item.second ? 1 : 0, queueCalls);
      const auto outcome = raiApplyDocumentEdit(doc->id(),"old","new","","");
      EXPECT_EQ(item.second,outcome.applied);
      boost::shared_ptr<source_database::SourceDocument> after(new source_database::SourceDocument());
      ASSERT_FALSE(source_database::get(doc->id(),after));
      EXPECT_EQ(item.second ? "before new after" : "before old after",after->contents());
      // Code buffers must be readable before a whole-buffer edit.
      EXPECT_EQ(item.second || boost::algorithm::ends_with(item.first, ".R"),
                raiIsEligibleDocument(doc,true));
   }
   boost::shared_ptr<source_database::SourceDocument> untitled(new source_database::SourceDocument("r_source"));
   EXPECT_TRUE(raiIsEligibleDocument(untitled));
   boost::shared_ptr<source_database::SourceDocument> text(new source_database::SourceDocument("text"));
   EXPECT_FALSE(raiIsEligibleDocument(text));
}
TEST(SessionRaiAssistant, S10cWholeBufferAdmission)
{
   const FilePath database = source_database::path();
   ASSERT_EQ(core::system::getenv("HOME"), core::system::getenv("TMPDIR"));
   ASSERT_FALSE(database.ensureDirectory());
   const std::string prior = s_sessionEndpointToken;
   s_sessionEndpointToken = "s10c-owning-handler";
   BOOST_SCOPE_EXIT_ALL(&) { s_sessionEndpointToken = prior; };
   boost::shared_ptr<source_database::SourceDocument> doc(new source_database::SourceDocument("r_source"));
   doc->setContents("old");
   const FilePath record = database.completePath(doc->id()), sidecar = database.completePath(doc->id()+"-contents");
   ASSERT_FALSE(record.exists()); ASSERT_FALSE(sidecar.exists());
   BOOST_SCOPE_EXIT_ALL(&) { EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); };
   ASSERT_FALSE(doc->writeToFile(record));
   ASSERT_FALSE(r::exec::executeString(
      "assign('.s10c_old_queue', get0('.rs.rai.queueDocumentEdit', envir=as.environment('tools:rstudio'), inherits=FALSE), .GlobalEnv); "
      "assign('.s10c_queue_calls', 0L, .GlobalEnv); assign('.rs.rai.queueDocumentEdit', function(...) { .s10c_queue_calls <<- .s10c_queue_calls + 1L; list(status='applying',approval='autonomous') }, as.environment('tools:rstudio'))"));
   BOOST_SCOPE_EXIT_ALL(&) {
      EXPECT_FALSE(r::exec::executeString("if (is.null(.s10c_old_queue)) rm('.rs.rai.queueDocumentEdit', envir=as.environment('tools:rstudio')) else assign('.rs.rai.queueDocumentEdit', .s10c_old_queue, as.environment('tools:rstudio')); rm(list=c('.s10c_old_queue','.s10c_queue_calls'), envir=.GlobalEnv)"));
   };
   struct Reply { int code; std::string text; int statusCode() const { return code; } const std::string& body() const { return text; } };
   auto post = [&](const std::string& body) {
      http::Request req; req.setMethod("POST"); req.setUri("/edit"); req.setHeader("X-RAI-Bridge-Token",s_sessionEndpointToken); req.setBody(body);
      http::Response res; EXPECT_FALSE(invokeDocumentProven(handleDocumentEditRequest,req,&res)); return Reply{res.statusCode(),res.body()};
   };
   auto read = [&](const std::string& extra) {
      http::Request req; req.setMethod("POST"); req.setUri("/document"); req.setHeader("X-RAI-Bridge-Token",s_sessionEndpointToken); req.setBody("document_id="+doc->id()+extra);
      http::Response res; EXPECT_FALSE(invokeDocumentProven(handleOpenDocumentRequest,req,&res)); EXPECT_EQ(200,res.statusCode()) << res.body(); return Reply{res.statusCode(),res.body()};
   };
   auto body = [&](const std::string& digest, const std::string& contents) {
      return "document_id="+doc->id()+"&expected_digest="+digest+"&contents="+contents;
   };
   std::string digest; ASSERT_FALSE(core::system::crypto::sha256Hex("old",&digest));
   auto unread = post(body(digest,"new"));
   EXPECT_EQ(400,unread.statusCode()); EXPECT_NE(std::string::npos,unread.body().find("read whole file first"));
   read("");
   auto accepted = post(body(digest,"new")); EXPECT_EQ(200,accepted.statusCode()) << accepted.body();
   auto empty = post(body(digest,"")); EXPECT_EQ(200,empty.statusCode()) << empty.body();
   auto large = post(body(digest,std::string(1024*1024+1,'x'))); EXPECT_EQ(200,large.statusCode()) << large.body();
   int calls=-1; ASSERT_FALSE(r::exec::RFunction("get",".s10c_queue_calls").call(&calls)); EXPECT_EQ(3,calls);
   // The encoded request body, including metadata, still cannot exceed 4 MiB.
   auto tooLarge = post(body(digest,std::string(4*1024*1024,'x'))); EXPECT_EQ(401,tooLarge.statusCode());
   ASSERT_FALSE(r::exec::RFunction("get",".s10c_queue_calls").call(&calls)); EXPECT_EQ(3,calls);
   auto wrong = post(body(std::string(64,'0'),"new")); EXPECT_EQ(400,wrong.statusCode());
   EXPECT_NE(std::string::npos,wrong.body().find("file changed since read"));
   read("");
   doc->setContents("other"); ASSERT_FALSE(doc->writeToFile(record));
   auto stale = post(body(digest,"new")); EXPECT_EQ(400,stale.statusCode());
   EXPECT_NE(std::string::npos,stale.body().find("file changed since read"));
   doc->setContents(std::string(1024*1024+1,'a')); ASSERT_FALSE(doc->writeToFile(record));
   ASSERT_FALSE(core::system::crypto::sha256Hex(doc->contents(),&digest));
   read("");
   auto partial = post(body(digest,"new")); EXPECT_EQ(400,partial.statusCode());
   EXPECT_NE(std::string::npos,partial.body().find("read whole file first"));
   for (std::size_t offset=65536; offset<doc->contents().size(); offset+=65536)
      read("&offset="+std::to_string(offset)+"&expected_digest="+digest);
   bool validRead=false;
   // Unit-test mode does not source the private R wrapper. Exercise its native
   // R-call entrypoint directly; the owning R suite covers the wrapper.
   r::sexp::Protect protectRead;
   SEXP readValid=rs_raiWholeFileReadValid(
      r::sexp::create(doc->id(),&protectRead), r::sexp::create(digest,&protectRead),
      r::sexp::create(doc->contents(),&protectRead));
   ASSERT_FALSE(r::sexp::extract(readValid,&validRead));
   EXPECT_TRUE(validRead) << "native R authority accepts a completed code read above 1 MiB";
   auto complete = post(body(digest,"new")); EXPECT_EQ(200,complete.statusCode()) << complete.body();
   doc->setContents("old"); ASSERT_FALSE(doc->writeToFile(record)); read("");
   source_database::events().onDocUpdated(doc);
   ASSERT_FALSE(core::system::crypto::sha256Hex("old",&digest));
   auto external = post(body(digest,"new")); EXPECT_EQ(400,external.statusCode());
   EXPECT_NE(std::string::npos,external.body().find("read whole file first"));
   read(""); source_database::events().onDocRemoved(doc->id(),doc->path());
   auto closed = post(body(digest,"new")); EXPECT_EQ(400,closed.statusCode());
   EXPECT_NE(std::string::npos,closed.body().find("read whole file first"));
   json::Object meta; doc->writeToJson(&meta); meta["path"] = database.completePath("data/x.R").getAbsolutePath();
   ASSERT_FALSE(doc->readFromJson(&meta)); ASSERT_FALSE(doc->writeToFile(record));
   auto denied=post(body(digest,"new")); EXPECT_EQ(400,denied.statusCode());
   EXPECT_NE(std::string::npos,denied.body().find("\"policy\":\"refused\""));

}

TEST(SessionRaiAssistant, S10cRegistryIdentityAndBound)
{
   s_raiReadTokens.clear();
   BOOST_SCOPE_EXIT_ALL(&) { s_raiReadTokens.clear(); };
   std::string message;
   raiObserveRead("disk:x", "digest", "revision1", 0, 5, 10);
   EXPECT_FALSE(raiHasReadToken("disk:x","digest","digest","revision1",&message));
   raiObserveRead("disk:x", "digest", "revision2", 5, 10, 10);
   EXPECT_FALSE(raiHasReadToken("disk:x","digest","digest","revision2",&message));
   raiObserveRead("disk:x", "digest", "revision1", 0, 10, 10);
   EXPECT_FALSE(raiHasReadToken("disk:x","digest","digest","revision2",&message));
   EXPECT_EQ("file changed since read",message);
   raiObserveRead("disk:x", "digest", "revision1", 5, 10, 10);
   EXPECT_FALSE(raiHasReadToken("disk:x","digest","digest","revision1",&message));
   for (int i=0;i<256;++i) raiObserveRead("key:"+std::to_string(i),"digest","",0,0,0);
   EXPECT_EQ(256U,s_raiReadTokens.size());
   EXPECT_TRUE(raiHasReadToken("key:0","digest","digest","",&message));
   raiObserveRead("key:256","digest","",0,0,0);
   EXPECT_EQ(256U,s_raiReadTokens.size());
   EXPECT_EQ(0U,s_raiReadTokens.count("key:1"));
   EXPECT_EQ(1U,s_raiReadTokens.count("key:0"));
}

TEST(SessionRaiAssistant, S10cWholeApplyAndPublish)
{
   const FilePath database = source_database::path();
   ASSERT_EQ(core::system::getenv("HOME"), core::system::getenv("TMPDIR"));
   ASSERT_FALSE(database.ensureDirectory());
   boost::shared_ptr<source_database::SourceDocument> doc(new source_database::SourceDocument("r_source"));
   doc->setContents("old");
   const FilePath record = database.completePath(doc->id()), sidecar = database.completePath(doc->id()+"-contents");
   ASSERT_FALSE(record.exists()); ASSERT_FALSE(sidecar.exists());
   BOOST_SCOPE_EXIT_ALL(&) { s_raiReadTokens.clear(); EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); };
   ASSERT_FALSE(doc->writeToFile(record));
   std::string digest; ASSERT_FALSE(core::system::crypto::sha256Hex("old",&digest));
   EXPECT_FALSE(raiApplyDocumentEdit(doc->id(),"old","","","",true,digest).applied);
   raiObserveRead("doc:"+doc->id(),digest,"",0,3,3);
   auto outcome=raiApplyDocumentEdit(doc->id(),"old","","","",true,digest);
   ASSERT_TRUE(outcome.applied) << outcome.failureReason;
   EXPECT_EQ("",outcome.newContents);
   EXPECT_EQ(0U,s_raiReadTokens.count("doc:"+doc->id()));
   raiPublishDocumentEdit(outcome);
   boost::shared_ptr<source_database::SourceDocument> stored(new source_database::SourceDocument());
   ASSERT_FALSE(source_database::get(doc->id(),stored)); EXPECT_EQ("",stored->contents());
   std::vector<ClientEvent> events; clientEventQueue().remove(&events);
   bool published = false;
   for (const auto& event : events)
   {
      if (event.type() == client_events::kEditorCommand &&
          event.data().write().find("replace_ranges") != std::string::npos &&
          event.data().write().find(doc->id()) != std::string::npos) published = true;
      clientEventQueue().add(event);
   }
   EXPECT_TRUE(published);
   std::string emptyDigest; ASSERT_FALSE(core::system::crypto::sha256Hex("",&emptyDigest));
   std::string message;
   EXPECT_TRUE(raiHasReadToken("doc:"+doc->id(),emptyDigest,emptyDigest,"",&message));
   auto second=raiApplyDocumentEdit(doc->id(),"",std::string(65536,'x'),"","",true,emptyDigest);
   ASSERT_TRUE(second.applied) << second.failureReason;
   EXPECT_EQ(65536U,second.newContents.size());
   EXPECT_TRUE(raiRollbackDocumentEdit(second));
   EXPECT_EQ(0U,s_raiReadTokens.count("doc:"+doc->id()));
}

TEST(SessionRaiAssistant, S11bPublicationPinsFullClientPreimage)
{
   const FilePath database = source_database::path();
   ASSERT_EQ(core::system::getenv("HOME"), core::system::getenv("TMPDIR"));
   ASSERT_FALSE(database.ensureDirectory());
   for (bool wholeFile : {false, true})
   {
      boost::shared_ptr<source_database::SourceDocument> doc(new source_database::SourceDocument("r_source"));
      const std::string old = "# human context\nx <- 1\n";
      doc->setContents(old);
      const FilePath record = database.completePath(doc->id()), sidecar = database.completePath(doc->id()+"-contents");
      BOOST_SCOPE_EXIT_ALL(&) { s_raiReadTokens.clear(); EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); };
      ASSERT_FALSE(doc->writeToFile(record));
      std::string digest;
      ASSERT_FALSE(core::system::crypto::sha256Hex(old, &digest));
      raiObserveRead("doc:"+doc->id(), digest, "", 0, old.size(), old.size());
      auto outcome = raiApplyDocumentEdit(doc->id(), wholeFile ? old : "1", wholeFile ? "x <- 2\n" : "2", "", "", wholeFile, digest);
      ASSERT_TRUE(outcome.applied) << outcome.failureReason;
      ASSERT_TRUE(raiPublishDocumentEdit(outcome));
      std::vector<ClientEvent> events;
      clientEventQueue().remove(&events);
      bool found = false;
      for (const auto& event : events)
      {
         const json::Value value = event.data();
         if (event.type() == client_events::kEditorCommand && value.isObject())
         {
            json::Object envelope = value.getObject();
            if (envelope.hasMember("type") && envelope["type"].getString() == "replace_ranges")
            {
               json::Object data = envelope["data"].getObject();
               if (data["id"].getString() == doc->id())
               {
                  found = true;
                  ASSERT_TRUE(data.hasMember("rai_edit"));
                  EXPECT_TRUE(data["rai_edit"].getBool());
                  ASSERT_TRUE(data.hasMember("expected_contents"));
                  EXPECT_EQ(old, data["expected_contents"].getString()) << "snippet must pin the whole editor";
               }
            }
         }
         clientEventQueue().add(event);
      }
      EXPECT_TRUE(found);
   }
}

TEST(SessionRaiAssistant, S10fixSnippetHandler)
{
   const FilePath database = source_database::path();
   ASSERT_EQ(core::system::getenv("HOME"), core::system::getenv("TMPDIR"));
   ASSERT_FALSE(database.ensureDirectory());
   const std::string prior = s_sessionEndpointToken;
   s_sessionEndpointToken = "s10c-owning-handler";
   BOOST_SCOPE_EXIT_ALL(&) { s_sessionEndpointToken = prior; };
   boost::shared_ptr<source_database::SourceDocument> doc(new source_database::SourceDocument("r_source"));
   doc->setContents("old");
   const FilePath record = database.completePath(doc->id()), sidecar = database.completePath(doc->id()+"-contents");
   ASSERT_FALSE(record.exists()); ASSERT_FALSE(sidecar.exists());
   BOOST_SCOPE_EXIT_ALL(&) { EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); };
   ASSERT_FALSE(doc->writeToFile(record));
   ASSERT_FALSE(r::exec::executeString(
      "assign('.s10c_old_queue', get0('.rs.rai.queueDocumentEdit', envir=as.environment('tools:rstudio'), inherits=FALSE), .GlobalEnv); "
      "assign('.s10c_queue_calls', 0L, .GlobalEnv); assign('.rs.rai.queueDocumentEdit', function(...) { .s10c_queue_calls <<- .s10c_queue_calls + 1L; list(status='applying',approval='autonomous') }, as.environment('tools:rstudio'))"));
   BOOST_SCOPE_EXIT_ALL(&) {
      EXPECT_FALSE(r::exec::executeString("if (is.null(.s10c_old_queue)) rm('.rs.rai.queueDocumentEdit', envir=as.environment('tools:rstudio')) else assign('.rs.rai.queueDocumentEdit', .s10c_old_queue, as.environment('tools:rstudio')); rm(list=c('.s10c_old_queue','.s10c_queue_calls'), envir=.GlobalEnv)"));
   };
   struct Reply { int code; std::string text; int statusCode() const { return code; } const std::string& body() const { return text; } };
   auto post = [&](const std::string& body) {
      http::Request req; req.setMethod("POST"); req.setUri("/edit"); req.setHeader("X-RAI-Bridge-Token",s_sessionEndpointToken); req.setBody(body);
      http::Response res; EXPECT_FALSE(invokeDocumentProven(handleDocumentEditRequest,req,&res)); return Reply{res.statusCode(),res.body()};
   };
   auto read = [&](const std::string& extra) {
      http::Request req; req.setMethod("POST"); req.setUri("/document"); req.setHeader("X-RAI-Bridge-Token",s_sessionEndpointToken); req.setBody("document_id="+doc->id()+extra);
      http::Response res; EXPECT_FALSE(invokeDocumentProven(handleOpenDocumentRequest,req,&res)); EXPECT_EQ(200,res.statusCode()) << res.body(); return Reply{res.statusCode(),res.body()};
   };
   auto body = [&](const std::string&, const std::string& contents) {
      return "document_id="+doc->id()+"&expected_text=old&replacement="+contents;
   };
   std::string digest; ASSERT_FALSE(core::system::crypto::sha256Hex("old",&digest));
   const auto initialEvents=s10fixEventCount();
   auto unread = post(body(digest,"new"));
   EXPECT_EQ(initialEvents,s10fixEventCount());
   EXPECT_EQ(400,unread.statusCode()); EXPECT_NE(std::string::npos,unread.body().find("read whole file first"));
   EXPECT_NE(std::string::npos,unread.body().find("\"policy\":\"refused\""));
   read("");
   auto accepted = post(body(digest,"new")); EXPECT_EQ(200,accepted.statusCode()) << accepted.body();
   int calls=-1; ASSERT_FALSE(r::exec::RFunction("get",".s10c_queue_calls").call(&calls)); EXPECT_EQ(1,calls);
   doc->setContents("old typed"); ASSERT_FALSE(doc->writeToFile(record));
   auto stale = post(body(digest,"new"));
   EXPECT_EQ(initialEvents,s10fixEventCount()); EXPECT_EQ(400,stale.statusCode());
   EXPECT_NE(std::string::npos,stale.body().find("file changed since read"));
   ASSERT_FALSE(r::exec::RFunction("get",".s10c_queue_calls").call(&calls)); EXPECT_EQ(1,calls);
   doc->setContents("old"+std::string(65534,'a')); ASSERT_FALSE(doc->writeToFile(record));
   ASSERT_FALSE(core::system::crypto::sha256Hex(doc->contents(),&digest));
   read("");
   auto partial = post(body(digest,"new")); EXPECT_EQ(400,partial.statusCode());
   EXPECT_NE(std::string::npos,partial.body().find("read whole file first"));
   read("&offset=65536&expected_digest="+digest);
   auto complete = post(body(digest,"new")); EXPECT_EQ(200,complete.statusCode()) << complete.body();
   doc->setContents("old"); ASSERT_FALSE(doc->writeToFile(record)); read("");
   source_database::events().onDocUpdated(doc);
   ASSERT_FALSE(core::system::crypto::sha256Hex("old",&digest));
   auto external = post(body(digest,"new")); EXPECT_EQ(400,external.statusCode());
   EXPECT_NE(std::string::npos,external.body().find("read whole file first"));
   read(""); source_database::events().onDocRemoved(doc->id(),doc->path());
   auto closed = post(body(digest,"new")); EXPECT_EQ(400,closed.statusCode());
   EXPECT_NE(std::string::npos,closed.body().find("read whole file first"));
}

TEST(SessionRaiAssistant, S10fixSnippetNativeQueue)
{
   const FilePath database=source_database::path();
   ASSERT_EQ(core::system::getenv("HOME"),core::system::getenv("TMPDIR"));
   ASSERT_FALSE(database.ensureDirectory());
   const std::string prior=s_sessionEndpointToken; s_sessionEndpointToken="s10fix-queue";
   boost::shared_ptr<source_database::SourceDocument> doc(new source_database::SourceDocument("r_source")); doc->setContents("a");
   const FilePath record=database.completePath(doc->id()),sidecar=database.completePath(doc->id()+"-contents");
   ASSERT_FALSE(record.exists()); ASSERT_FALSE(sidecar.exists());
   BOOST_SCOPE_EXIT_ALL(&) { s_sessionEndpointToken=prior; s_raiReadTokens.clear(); EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); };
   ASSERT_FALSE(doc->writeToFile(record));
   ASSERT_FALSE(r::exec::executeString(".s10fix_state <- get('.rs.rai.grantState',as.environment('tools:rstudio')); .s10fix_requests <- .s10fix_state$requests; .s10fix_state$requests <- new.env(parent=emptyenv())"));
   BOOST_SCOPE_EXIT_ALL(&) { EXPECT_FALSE(r::exec::executeString(".s10fix_state$requests <- .s10fix_requests; rm(.s10fix_state,.s10fix_requests)")); };
   auto queue=[&]() {
      r::sexp::Protect protect; SEXP result=R_NilValue;
      EXPECT_FALSE(r::exec::RFunction(".rs.rai.queueDocumentEdit",doc->id(),"a","b").call(&result,&protect));
      return raiListField(result,"status");
   };
   const auto unreadEvents=s10fixEventCount();
   EXPECT_EQ("error",queue()); EXPECT_EQ(unreadEvents,s10fixEventCount());
   http::Request read; read.setMethod("POST"); read.setUri("/document"); read.setHeader("X-RAI-Bridge-Token",s_sessionEndpointToken); read.setBody("document_id="+doc->id());
   http::Response response; ASSERT_FALSE(invokeDocumentProven(handleOpenDocumentRequest,read,&response)); ASSERT_EQ(200,response.statusCode());
   EXPECT_EQ("applying",queue());
   doc->setContents("a typed"); ASSERT_FALSE(doc->writeToFile(record));
   const auto staleEvents=s10fixEventCount();
   EXPECT_EQ("error",queue()); EXPECT_EQ(staleEvents,s10fixEventCount());
}

namespace {
SEXP s10fixInvalidateDuringAudit()
{
   s_raiReadTokens.clear();
   return Rf_ScalarInteger(1);
}
}

TEST(SessionRaiAssistant, S10fixSnippetApplyRecheck)
{
   const FilePath database=source_database::path();
   ASSERT_EQ(core::system::getenv("HOME"),core::system::getenv("TMPDIR"));
   ASSERT_FALSE(database.ensureDirectory());
   const std::string prior=s_sessionEndpointToken; s_sessionEndpointToken="s10fix-audit";
   boost::shared_ptr<source_database::SourceDocument> doc(new source_database::SourceDocument("r_markdown"));
   doc->setContents("```{r}\na <- 1\n```\n");
   const FilePath record=database.completePath(doc->id()),sidecar=database.completePath(doc->id()+"-contents");
   ASSERT_FALSE(record.exists()); ASSERT_FALSE(sidecar.exists());
   BOOST_SCOPE_EXIT_ALL(&) { s_sessionEndpointToken=prior; s_raiReadTokens.clear(); EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); };
   ASSERT_FALSE(doc->writeToFile(record));
   http::Request read; read.setMethod("POST"); read.setUri("/document");
   read.setHeader("X-RAI-Bridge-Token",s_sessionEndpointToken); read.setBody("document_id="+doc->id());
   http::Response response; ASSERT_FALSE(invokeDocumentProven(handleOpenDocumentRequest,read,&response)); ASSERT_EQ(200,response.statusCode());
   r::sexp::Protect protect;
   SEXP pointer=R_MakeExternalPtrFn(reinterpret_cast<DL_FUNC>(&s10fixInvalidateDuringAudit),Rf_install("native symbol"),R_NilValue);
   protect.add(pointer);
   SEXP pointerClass=Rf_mkString("NativeSymbol"); protect.add(pointerClass); Rf_classgets(pointer,pointerClass);
   Rf_defineVar(Rf_install(".s10fix_audit_invalidate"),pointer,R_GlobalEnv);
   ASSERT_FALSE(r::exec::executeString(".s10fix_old_count <- get('.rs.rai.countParseableChunks',as.environment('tools:rstudio')); assign('.rs.rai.countParseableChunks',function(...) .Call(.s10fix_audit_invalidate),as.environment('tools:rstudio'))"));
   BOOST_SCOPE_EXIT_ALL(&) { EXPECT_FALSE(r::exec::executeString("assign('.rs.rai.countParseableChunks',.s10fix_old_count,as.environment('tools:rstudio')); rm(.s10fix_old_count,.s10fix_audit_invalidate)")); };
   const auto eventsBefore=s10fixEventCount();
   auto result=raiApplyDocumentEdit(doc->id(),"a <- 1","a <- 2","```{r}\n","\n```\n");
   EXPECT_FALSE(result.applied); EXPECT_EQ(eventsBefore,s10fixEventCount());
   EXPECT_EQ("read whole file first / file changed since read",result.failureReason);
   boost::shared_ptr<source_database::SourceDocument> stored(new source_database::SourceDocument());
   ASSERT_FALSE(source_database::get(doc->id(),stored)); EXPECT_EQ(doc->contents(),stored->contents());
}

TEST(SessionRaiAssistant, S10fixSnippetUnreadStaleApply)
{
   const FilePath database=source_database::path();
   ASSERT_EQ(core::system::getenv("HOME"),core::system::getenv("TMPDIR"));
   ASSERT_FALSE(database.ensureDirectory());
   const std::string prior=s_sessionEndpointToken; s_sessionEndpointToken="s10fix-red";
   boost::shared_ptr<source_database::SourceDocument> doc(new source_database::SourceDocument("r_source")); doc->setContents("a");
   const FilePath record=database.completePath(doc->id()),sidecar=database.completePath(doc->id()+"-contents");
   ASSERT_FALSE(record.exists()); ASSERT_FALSE(sidecar.exists());
   BOOST_SCOPE_EXIT_ALL(&) { s_sessionEndpointToken=prior; s_raiReadTokens.clear(); EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); };
   ASSERT_FALSE(doc->writeToFile(record));
   const auto initialEvents=s10fixEventCount();
   auto unread=raiApplyDocumentEdit(doc->id(),"a","b","",""); EXPECT_FALSE(unread.applied);
   EXPECT_EQ(initialEvents,s10fixEventCount());
   doc->setContents("a"); ASSERT_FALSE(doc->writeToFile(record));
   http::Request read; read.setMethod("POST"); read.setUri("/document"); read.setHeader("X-RAI-Bridge-Token",s_sessionEndpointToken); read.setBody("document_id="+doc->id());
   http::Response response; ASSERT_FALSE(invokeDocumentProven(handleOpenDocumentRequest,read,&response)); ASSERT_EQ(200,response.statusCode());
   auto control=raiApplyDocumentEdit(doc->id(),"a","b","",""); ASSERT_TRUE(control.applied) << control.failureReason;
   doc->setContents("a"); ASSERT_FALSE(doc->writeToFile(record));
   http::Response fresh; ASSERT_FALSE(invokeDocumentProven(handleOpenDocumentRequest,read,&fresh)); ASSERT_EQ(200,fresh.statusCode());
   doc->setContents("a typed"); ASSERT_FALSE(doc->writeToFile(record));
   auto stale=raiApplyDocumentEdit(doc->id(),"a","b","",""); EXPECT_FALSE(stale.applied);
   EXPECT_EQ(initialEvents,s10fixEventCount());
   boost::shared_ptr<source_database::SourceDocument> stored(new source_database::SourceDocument());
   ASSERT_FALSE(source_database::get(doc->id(),stored)); EXPECT_EQ("a typed",stored->contents());
}

TEST(SessionRaiAssistant, S10fixSnippetApply)
{
   const FilePath database = source_database::path();
   ASSERT_EQ(core::system::getenv("HOME"), core::system::getenv("TMPDIR"));
   ASSERT_FALSE(database.ensureDirectory());
   const std::string prior=s_sessionEndpointToken; s_sessionEndpointToken="s10fix-read";
   boost::shared_ptr<source_database::SourceDocument> doc(new source_database::SourceDocument("r_source"));
   doc->setContents("a");
   const FilePath record=database.completePath(doc->id()), sidecar=database.completePath(doc->id()+"-contents");
   ASSERT_FALSE(record.exists()); ASSERT_FALSE(sidecar.exists());
   BOOST_SCOPE_EXIT_ALL(&) { s_sessionEndpointToken=prior; s_raiReadTokens.clear(); EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); };
   ASSERT_FALSE(doc->writeToFile(record));
   EXPECT_FALSE(raiApplyDocumentEdit(doc->id(),"a","b","","").applied);
   http::Request read; read.setMethod("POST"); read.setUri("/document");
   read.setHeader("X-RAI-Bridge-Token",s_sessionEndpointToken); read.setBody("document_id="+doc->id());
   http::Response response; ASSERT_FALSE(invokeDocumentProven(handleOpenDocumentRequest,read,&response)); ASSERT_EQ(200,response.statusCode());
   auto first=raiApplyDocumentEdit(doc->id(),"a","b","",""); ASSERT_TRUE(first.applied) << first.failureReason;
   raiPublishDocumentEdit(first);
   boost::shared_ptr<source_database::SourceDocument> typed(new source_database::SourceDocument());
   ASSERT_FALSE(source_database::get(doc->id(),typed)); typed->setContents("b typed"); ASSERT_FALSE(source_database::put(typed));
   auto intervening=raiApplyDocumentEdit(doc->id(),"b","c","",""); EXPECT_FALSE(intervening.applied);
   EXPECT_EQ("read whole file first / file changed since read",intervening.failureReason);
   typed->setContents("b"); ASSERT_FALSE(source_database::put(typed));
   http::Response reread; ASSERT_FALSE(invokeDocumentProven(handleOpenDocumentRequest,read,&reread)); ASSERT_EQ(200,reread.statusCode());
   auto second=raiApplyDocumentEdit(doc->id(),"b","c","",""); ASSERT_TRUE(second.applied) << second.failureReason;
   raiPublishDocumentEdit(second);
   auto third=raiApplyDocumentEdit(doc->id(),"c","e","",""); ASSERT_TRUE(third.applied) << third.failureReason;
   raiPublishDocumentEdit(third);
   boost::shared_ptr<source_database::SourceDocument> stored(new source_database::SourceDocument());
   ASSERT_FALSE(source_database::get(doc->id(),stored)); stored->setContents("c typed"); ASSERT_FALSE(source_database::put(stored));
   auto stale=raiApplyDocumentEdit(doc->id(),"c","d","",""); EXPECT_FALSE(stale.applied);
   EXPECT_EQ("read whole file first / file changed since read",stale.failureReason);
   ASSERT_FALSE(source_database::get(doc->id(),stored)); EXPECT_EQ("c typed",stored->contents());
}


namespace {
void s10fix3CompletionWindow(bool publish, bool removedOnly = false)
{
   const FilePath database = source_database::path();
   ASSERT_EQ(core::system::getenv("HOME"), core::system::getenv("TMPDIR"));
   ASSERT_TRUE(database.isWithin(FilePath(core::system::getenv("HOME"))));
   ASSERT_FALSE(database.ensureDirectory());
   const std::string prior = s_sessionEndpointToken;
   s_sessionEndpointToken = "s10fix3-completion";
   BOOST_SCOPE_EXIT_ALL(&) { s_sessionEndpointToken = prior; s_raiReadTokens.clear(); };
   // Direct completion seams model the interval occupied by the R completion call
   for (const std::string& mode : removedOnly ? std::vector<std::string>{"unchanged", "removed"} :
        std::vector<std::string>{"unchanged", "edited", "removed", "closed", "identity", "type", "classifier", "read-only", "revision", "notification-edit"})
   {
      SCOPED_TRACE(mode);
      if (!publish && mode == "notification-edit") continue;
      boost::shared_ptr<source_database::SourceDocument> doc(new source_database::SourceDocument("r_source"));
      doc->setContents("a");
      const FilePath record = database.completePath(doc->id());
      const FilePath sidecar = database.completePath(doc->id() + "-contents");
      ASSERT_FALSE(record.exists()); ASSERT_FALSE(sidecar.exists());
      BOOST_SCOPE_EXIT_ALL(&) { EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); };
      ASSERT_FALSE(doc->writeToFile(record));
      http::Request read; read.setMethod("POST"); read.setUri("/document");
      read.setHeader("X-RAI-Bridge-Token", s_sessionEndpointToken); read.setBody("document_id=" + doc->id());
      http::Response response;
      ASSERT_FALSE(invokeDocumentProven(handleOpenDocumentRequest, read, &response));
      ASSERT_EQ(200, response.statusCode());
      auto outcome = raiApplyDocumentEdit(doc->id(), "a", "b", "", "");
      ASSERT_TRUE(outcome.applied) << outcome.failureReason;
      ASSERT_EQ(0u, s_raiReadTokens.count("doc:" + doc->id()));
      boost::shared_ptr<source_database::SourceDocument> live(new source_database::SourceDocument());
      ASSERT_FALSE(source_database::get(doc->id(), live));
      ASSERT_NE(live.get(), outcome.document.get());
      ASSERT_EQ("b", live->contents());
      if (mode == "edited") { live->setContents("user edit"); ASSERT_FALSE(live->writeToFile(record)); }
      if (mode == "removed" || mode == "closed")
      {
         ASSERT_FALSE(source_database::remove(doc->id()));
         ASSERT_FALSE(sidecar.removeIfExists());
         if (mode == "closed") source_database::events().onDocRemoved(doc->id(), "");
         ASSERT_FALSE(record.exists()); ASSERT_FALSE(sidecar.exists());
      }
      if (mode == "identity")
      {
         json::Object metadata; live->writeToJson(&metadata);
         metadata["created"] = live->created() + 1;
         ASSERT_FALSE(live->readFromJson(&metadata)); ASSERT_FALSE(live->writeToFile(record));
      }
      if (mode == "type") { live->setType("text"); ASSERT_FALSE(live->writeToFile(record)); }
      if (mode == "classifier")
      {
         json::Object metadata; live->writeToJson(&metadata);
         metadata["path"] = database.completePath("data/x.R").getAbsolutePath();
         ASSERT_FALSE(live->readFromJson(&metadata)); ASSERT_FALSE(live->writeToFile(record));
      }
      if (mode == "read-only")
      {
         live->setContents("# do not edit by hand\nb"); ASSERT_FALSE(live->writeToFile(record));
         ASSERT_TRUE(raiDocumentIsReadOnly(live));
      }
      if (mode == "type" || mode == "classifier") ASSERT_FALSE(raiIsEligibleDocument(live));
      if (mode == "revision")
      {
         // Same bytes and metadata, but an intervening source event invalidates the revision
         const auto revision = s_sourceRevision.load();
         source_database::events().onDocUpdated(live);
         ASSERT_NE(revision, s_sourceRevision.load());
      }
      auto notification = source_database::events().onDocUpdated.connect([&](boost::shared_ptr<source_database::SourceDocument> updated) {
         if (mode == "notification-edit" && updated->id() == doc->id())
         { live->setContents("notification edit"); EXPECT_FALSE(live->writeToFile(record)); }
      });
      BOOST_SCOPE_EXIT_ALL(&) { notification.disconnect(); };
      const auto eventsBefore = s10fixEventCount();
      if (publish)
      {
         raiPublishDocumentEdit(outcome);
         EXPECT_EQ(mode == "unchanged" ? eventsBefore + 1 : eventsBefore, s10fixEventCount()) << "publication event";
         EXPECT_EQ(mode == "unchanged" ? 1u : 0u, s_raiReadTokens.count("doc:" + doc->id())) << "completion authority";
      }
      else
      {
         const bool rolledBack = raiRollbackDocumentEdit(outcome);
         EXPECT_EQ(mode == "unchanged", rolledBack) << "rollback live recheck";
         EXPECT_EQ(eventsBefore, s10fixEventCount());
         EXPECT_EQ(0u, s_raiReadTokens.count("doc:" + doc->id()));
      }
      if (mode == "removed" || mode == "closed")
      {
         EXPECT_FALSE(record.exists()) << "removed record must stay absent";
         EXPECT_FALSE(sidecar.exists()) << "removed sidecar must stay absent";
      }
      else
      {
         boost::shared_ptr<source_database::SourceDocument> stored(new source_database::SourceDocument());
         ASSERT_FALSE(source_database::get(doc->id(), stored));
         EXPECT_EQ(mode == "unchanged" && !publish ? "a" : live->contents(), stored->contents()) << "live contents preserved";
         if (mode != "unchanged")
         {
            json::Object before, after; live->writeToJson(&before, false); stored->writeToJson(&after, false);
            EXPECT_EQ(before.write(), after.write()) << "live identity and metadata preserved";
         }
      }
      s_raiReadTokens.erase("doc:" + doc->id());
   }
}
}
TEST(SessionRaiAssistant, S10fix3CompletionRollback)
{
   ASSERT_NO_FATAL_FAILURE(s10fix3CompletionWindow(false));
}
TEST(SessionRaiAssistant, S10fix3CompletionPublication)
{
   ASSERT_NO_FATAL_FAILURE(s10fix3CompletionWindow(true));
}
TEST(SessionRaiAssistant, S10fix3CompletionRemint)
{
   ASSERT_NO_FATAL_FAILURE(s10fix3CompletionWindow(true, true));
}
TEST(SessionRaiAssistant, S10fix3CompletionRemovedRollback)
{
   ASSERT_NO_FATAL_FAILURE(s10fix3CompletionWindow(false, true));
}

#ifndef _WIN32
class S10dDiskWrite : public ::testing::Test
{
protected:
   FilePath root;
   std::string previousToken;
   struct Reply { int code; std::string body; };
   void SetUp() override
   {
      ASSERT_EQ(core::system::getenv("HOME"), core::system::getenv("TMPDIR"));
      root = FilePath(core::system::getenv("TMPDIR")).completeChildPath(core::system::generateUuid(false));
      ASSERT_FALSE(root.ensureDirectory()); ASSERT_FALSE(source_database::path().ensureDirectory());
      previousToken = s_sessionEndpointToken; s_sessionEndpointToken = "s10d-disk-token";
      s_raiDiskTestRoot = root; s_raiReadTokens.clear();
      ASSERT_FALSE(r::exec::executeString(
         "assign('.s10d_trace_old', get0('.rs.rai.traceDiskWrite', envir=as.environment('tools:rstudio'), inherits=FALSE), .GlobalEnv); "
         "assign('.s10d_trace_events', character(), .GlobalEnv); "
         "assign('.rs.rai.traceDiskWrite', function(event,...) { .s10d_trace_events <<- c(.s10d_trace_events,event); TRUE }, as.environment('tools:rstudio'))"));
   }
   void TearDown() override
   {
      s_sessionEndpointToken = previousToken; s_raiDiskTestRoot = FilePath();
      s_raiDiskBeforeCommit = nullptr; s_raiDiskBeforeOpen = nullptr;
      s_raiDiskAtRename = nullptr; s_raiDiskAfterRename = nullptr; s_raiDiskBeforeRename = nullptr; s_raiReadTokens.clear();
      EXPECT_FALSE(root.removeIfExists());
      EXPECT_FALSE(r::exec::executeString(
         "if (is.null(.s10d_trace_old)) rm('.rs.rai.traceDiskWrite', envir=as.environment('tools:rstudio')) else assign('.rs.rai.traceDiskWrite', .s10d_trace_old, as.environment('tools:rstudio')); rm(list=c('.s10d_trace_old','.s10d_trace_events'), envir=.GlobalEnv)"));
   }
   FilePath file(const std::string& name) { return root.completePath(name); }
   void put(const std::string& name, const std::string& bytes = "old")
   { ASSERT_FALSE(file(name).getParent().ensureDirectory()); ASSERT_FALSE(writeStringToFile(file(name),bytes)); }
   std::string hash(const std::string& text)
   { std::string value; EXPECT_FALSE(core::system::crypto::sha256Hex(text,&value)); return value; }
   Reply post(const std::string& uri, const std::string& body, bool proof = true)
   {
      http::Request request; request.setMethod("POST"); request.setUri(uri); request.setBody(body);
      if (proof) request.setHeader("X-RAI-Bridge-Token",s_sessionEndpointToken);
      http::Response response;
      auto handler = uri == "/write" ? handleWriteProjectFileRequest : handleReadProjectFileRequest;
      EXPECT_FALSE(invokeDocumentProven(handler,request,&response));
      return {response.statusCode(),response.body()};
   }
   Reply write(const std::string& path, const std::string& digest, const std::string& encoded = "new")
   { return post("/write","path="+path+"&expected_digest="+digest+"&contents="+encoded); }
   void read(const std::string& path, std::size_t bytes = 3)
   {
      for (std::size_t offset=0;;offset+=65536)
      {
         const auto reply = post("/file","path="+path+"&offset="+std::to_string(offset));
         ASSERT_EQ(200,reply.code) << reply.body;
         if (offset + 65536 >= bytes) break;
      }
   }
   std::string bytes(const std::string& name)
   { std::string result; EXPECT_FALSE(readStringFromFile(file(name),&result)); return result; }
   void noTemps()
   {
      std::vector<FilePath> children; ASSERT_FALSE(root.getChildren(children));
      for (const auto& child : children) EXPECT_NE(0U,child.getFilename().find(".rai-write-")) << child.getFilename();
   }
};

class S11SettingsBackup
{
   FilePath file_ = raiConfigFile();
   bool existed_ = file_.exists();
   std::string bytes_;
public:
   S11SettingsBackup() { if (existed_) EXPECT_FALSE(readStringFromFile(file_, &bytes_)); }
   ~S11SettingsBackup() {
      if (existed_) EXPECT_FALSE(writeStringToFile(file_, bytes_));
      else EXPECT_FALSE(file_.removeIfExists());
   }
   void put(const std::string& bytes) { ASSERT_FALSE(writeStringToFile(file_, bytes)); }
};

TEST_F(S10dDiskWrite, S11StoredSaveSettingIsIgnored)
{
   S11SettingsBackup settings;
   for (const char* stored : {"{\"saveOnEdit\":false}", "{\"saveOnEdit\":\"false\"}", "{\"saveOnEdit\":0}",
                              "{\"saveOnEdit\":null}", "broken JSON", "{}"})
   {
      settings.put(stored);
      put("a.R"); read("a.R");
      auto reply = write("a.R", hash("old"));
      EXPECT_EQ(200, reply.code) << "S11 stored " << stored << " never blocks /write " << reply.body;
      EXPECT_EQ("new", bytes("a.R")); noTemps();
   }
}

TEST_F(S10dDiskWrite, S11OffDuringFlightIsIgnored)
{
   S11SettingsBackup settings; settings.put("{\"saveOnEdit\":true}");
   put("a.R"); read("a.R");
   s_raiDiskBeforeRename = [&](const std::string&) { settings.put("{\"saveOnEdit\":false}"); };
   auto reply = write("a.R", hash("old"));
   EXPECT_EQ(200, reply.code) << "S11 later OFF does not block rename " << reply.body;
   EXPECT_EQ("new", bytes("a.R")); noTemps();
}

TEST_F(S10dDiskWrite, S11NativeSettingsTransaction)
{
   S11SettingsBackup settings;
   json::Value defaults; ASSERT_FALSE(defaults.parse(kRaiDefaultConfigJson));
   json::Object config = defaults.getObject();
   config.insert("theme", "dark"); config.insert("fontSize", 10);
   config.insert("globalPrompt", ""); config.insert("snippets", json::Object());
   settings.put(config.write());
   auto save = [&](const json::Value& value) {
      config.insert("saveOnEdit", value);
      std::string bytes; EXPECT_FALSE(readStringFromFile(raiConfigFile(), &bytes));
      std::string revision; EXPECT_FALSE(raiSettingsRevision(bytes, &revision));
      http::Request request; request.setMethod("POST"); request.setUri("/settings");
      request.setHeader("X-RAI-Bridge-Token", s_sessionEndpointToken);
      request.setBody("operation=save&expected_revision=" + revision + "&settings=" +
                      http::util::urlEncode(config.write()));
      http::Response response;
      EXPECT_FALSE(invokeDocumentProven(handleSettingsRequest, request, &response));
      return response.statusCode();
   };
   std::string beforeInvalid; ASSERT_FALSE(readStringFromFile(raiConfigFile(), &beforeInvalid));
   EXPECT_NE(200, save(json::Value("false"))) << "S11 native rejects invalid type";
   std::string afterInvalid; ASSERT_FALSE(readStringFromFile(raiConfigFile(), &afterInvalid));
   EXPECT_EQ(beforeInvalid, afterInvalid) << "S11 invalid save preserves bytes";
   EXPECT_EQ(200, save(json::Value(false))) << "S11 native still accepts the retired key";
   std::string bytes; ASSERT_FALSE(readStringFromFile(raiConfigFile(), &bytes));
   json::Value stored; ASSERT_FALSE(stored.parse(bytes));
   ASSERT_TRUE(stored.getObject().hasMember("saveOnEdit")) << "S11 native allowlist persists key";
   EXPECT_FALSE(stored.getObject()["saveOnEdit"].getBool()) << "S11 native keeps the retired key as sent";
   put("a.R"); read("a.R");
   EXPECT_EQ(200, write("a.R", hash("old")).code) << "S11 the retired key never gates /write";
   EXPECT_EQ("new", this->bytes("a.R"));
}

TEST_F(S10dDiskWrite, HappyPath)
{
   put("a.R"); ASSERT_EQ(0,::chmod(file("a.R").getAbsolutePath().c_str(),0640));
   struct stat before, after; ASSERT_EQ(0,::stat(file("a.R").getAbsolutePath().c_str(),&before));
   read("a.R"); auto reply=write("a.R",hash("old"));
   EXPECT_EQ(200,reply.code) << "atomic write applies " << reply.body;
   EXPECT_NE(std::string::npos,reply.body.find("autonomous"));
   EXPECT_EQ("new",bytes("a.R"));
   ASSERT_EQ(0,::stat(file("a.R").getAbsolutePath().c_str(),&after));
   EXPECT_NE(before.st_ino,after.st_ino) << "atomic replacement changes inode";
   EXPECT_EQ(0640,after.st_mode & 07777) << "original mode preserved";
   EXPECT_EQ(before.st_uid,after.st_uid); EXPECT_EQ(before.st_gid,after.st_gid);
   auto second=write("a.R",hash("new"),"");
   EXPECT_EQ(200,second.code) << "successful write remints token " << second.body;
   EXPECT_EQ("",bytes("a.R"));
   auto maximum=write("a.R",hash(""),std::string(1048576,'x'));
   EXPECT_EQ(200,maximum.code) << "exact ceiling admitted " << maximum.body;
   EXPECT_EQ(std::string(1048576,'x'),bytes("a.R")); noTemps();
   ASSERT_FALSE(r::exec::executeString("stopifnot(identical(.s10d_trace_events, rep(c('edit_apply_requested','edit_applied'),3L)))"));
}

TEST_F(S10dDiskWrite, TempIdentity)
{
   put("a.R"); read("a.R");
   s_raiDiskAtRename = [&](const std::string& temp) {
      ASSERT_EQ(0, ::unlink(file(temp).getAbsolutePath().c_str()));
      put(temp, "evil");
   };
   const auto reply = write("a.R", hash("old"));
   EXPECT_EQ(400, reply.code) << "swapped temporary entry refused";
   EXPECT_EQ("old", bytes("a.R")) << "temp identity check blocks replacement bytes";
   s_raiDiskAtRename = nullptr;
   EXPECT_EQ(400, write("a.R", hash("old")).code) << "temp mismatch revokes token";
}

TEST_F(S10dDiskWrite, InstalledIdentity)
{
   put("a.R"); read("a.R");
   s_raiDiskAfterRename = [&]() {
      ASSERT_EQ(0, ::unlink(file("a.R").getAbsolutePath().c_str()));
      put("a.R", "new");
   };
   const auto reply = write("a.R", hash("old"));
   EXPECT_EQ(400, reply.code) << "installed identity mismatch cannot report success";
   EXPECT_NE(std::string::npos, reply.body.find("completion unverified"));
   s_raiDiskAfterRename = nullptr;
   EXPECT_EQ(400, write("a.R", hash("new")).code) << "installed mismatch cannot remint";
}

TEST_F(S10dDiskWrite, InstalledDigest)
{
   put("a.R"); read("a.R");
   s_raiDiskAfterRename = [&]() { put("a.R", "bad"); };
   const auto reply = write("a.R", hash("old"));
   EXPECT_EQ(400, reply.code) << "installed content digest mismatch cannot report success";
   s_raiDiskAfterRename = nullptr;
   EXPECT_EQ(400, write("a.R", hash("bad")).code) << "content mismatch cannot remint";
}

TEST_F(S10dDiskWrite, CrashRecovery)
{
   put("a.R"); read("a.R");
   // Model a process dying after writing its private temp, before rename.
   const std::string stale = ".rai-write-0123456789abcdef0123456789abcdef";
   put(stale, "private replacement");
   ASSERT_EQ(0, ::chmod(file(stale).getAbsolutePath().c_str(), 0600));
   const time_t old = ::time(nullptr) - 90000;
   const timespec times[2] = {{old, 0}, {old, 0}};
   ASSERT_EQ(0, ::utimensat(AT_FDCWD, file(stale).getAbsolutePath().c_str(), times, 0));
   put(".rai-write-user-not-a-uuid", "user content");
   ASSERT_EQ(0, ::utimensat(AT_FDCWD, file(".rai-write-user-not-a-uuid").getAbsolutePath().c_str(), times, 0));
   EXPECT_EQ(200, write("a.R", hash("old")).code);
   EXPECT_FALSE(file(stale).exists()) << "stale crash temporary swept on next write";
   EXPECT_EQ("new", bytes("a.R")) << "crash temporary is never installed as content";
   EXPECT_EQ("user content", bytes(".rai-write-user-not-a-uuid")) << "nonmatching user content preserved";
}

TEST_F(S10dDiskWrite, SweepGuards)
{
   put("a.R"); read("a.R");
   const std::string fresh = ".rai-write-11111111111111111111111111111111";
   const std::string link = ".rai-write-22222222222222222222222222222222";
   const std::string dir = ".rai-write-33333333333333333333333333333333";
   const std::string live = ".rai-write-77777777777777777777777777777777";
   put(live);
   RaiDiskFd liveWriter(::open(file(live).getAbsolutePath().c_str(), O_WRONLY | O_NOFOLLOW));
   ASSERT_GE(liveWriter.fd, 0); ASSERT_EQ(0, ::flock(liveWriter.fd, LOCK_EX | LOCK_NB));
   put(fresh, "fresh"); put("victim.R", "user");
   const time_t old = ::time(nullptr) - 90000;
   const timespec times[2] = {{old, 0}, {old, 0}};
   ASSERT_EQ(0, ::utimensat(AT_FDCWD, file("victim.R").getAbsolutePath().c_str(), times, 0));
   ASSERT_EQ(0, ::utimensat(AT_FDCWD, file(live).getAbsolutePath().c_str(), times, 0));
   ASSERT_EQ(0, ::symlink(file("victim.R").getAbsolutePath().c_str(), file(link).getAbsolutePath().c_str()));
   ASSERT_FALSE(file(dir).ensureDirectory()); put(dir + "/user.R", "nested");
   ASSERT_EQ(0, ::utimensat(AT_FDCWD, file(dir).getAbsolutePath().c_str(), times, 0));
   EXPECT_EQ(200, write("a.R", hash("old")).code);
   EXPECT_TRUE(file(fresh).exists()) << "fresh temporary must not be swept";
   EXPECT_TRUE(file(live).exists()) << "live temporary must not be swept";
   struct stat info;
   EXPECT_EQ(0, ::lstat(file(link).getAbsolutePath().c_str(), &info)) << "sweep must not follow symlink";
   EXPECT_EQ("user", bytes("victim.R"));
   EXPECT_EQ("nested", bytes(dir + "/user.R")) << "sweep never traverses directories";
}

TEST_F(S10dDiskWrite, AgedLiveTemp)
{
   put("a.R"); read("a.R");
   const std::string live = ".rai-write-44444444444444444444444444444444";
   const std::string abandoned = ".rai-write-55555555555555555555555555555555";
   const std::string fresh = ".rai-write-66666666666666666666666666666666";
   put(live); put(abandoned); put(fresh);
   RaiDiskFd writer(::open(file(live).getAbsolutePath().c_str(), O_WRONLY | O_NOFOLLOW));
   ASSERT_GE(writer.fd, 0); ASSERT_EQ(0, ::flock(writer.fd, LOCK_EX | LOCK_NB));
   const time_t old = ::time(nullptr) - 90000;
   const timeval times[2] = {{old, 0}, {old, 0}};
   ASSERT_EQ(0, ::utimes(file(live).getAbsolutePath().c_str(), times));
   ASSERT_EQ(0, ::utimes(file(abandoned).getAbsolutePath().c_str(), times));
   EXPECT_EQ(200, write("a.R", hash("old")).code);
   EXPECT_TRUE(file(live).exists()) << "aged live temporary survives sweep";
   EXPECT_FALSE(file(abandoned).exists()) << "aged abandoned temporary reclaimed";
   EXPECT_TRUE(file(fresh).exists()) << "fresh temporary survives sweep";
}

TEST_F(S10dDiskWrite, WriterLockLifetime)
{
   put("a.R"); read("a.R");
   unsigned checked = 0;
   auto check = [&](const std::string& temporary) {
      RaiDiskFd probe(::open(file(temporary).getAbsolutePath().c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
      ASSERT_GE(probe.fd, 0);
      errno = 0;
      EXPECT_EQ(-1, ::flock(probe.fd, LOCK_EX | LOCK_NB)) << "writer holds lock through rename";
      EXPECT_EQ(EWOULDBLOCK, errno) << "writer lock excludes a separate open descriptor";
      const time_t old = ::time(nullptr) - 90000;
      const timeval times[2] = {{old, 0}, {old, 0}};
      ASSERT_EQ(0, ::utimes(file(temporary).getAbsolutePath().c_str(), times));
      RaiDiskFd directory(::open(root.getAbsolutePath().c_str(), O_RDONLY | O_DIRECTORY));
      ASSERT_GE(directory.fd, 0);
      raiSweepDiskTemps(directory.fd);
      EXPECT_TRUE(file(temporary).exists()) << "actual aged writer temporary survives sweep";
      ++checked;
   };
   s_raiDiskAtRename = check;
   s_raiDiskBeforeRename = check;
   EXPECT_EQ(200, write("a.R", hash("old")).code) << "aged writer can finish rename";
   EXPECT_EQ(2u, checked) << "lock checked during validation and immediately before rename";
}

TEST_F(S10dDiskWrite, ParentMoved)
{
   put("code/a.R"); read("code/a.R");
   ASSERT_FALSE(file("raw").ensureDirectory());
   s_raiDiskAtRename = [&](const std::string&) {
      ASSERT_EQ(0, ::rename(file("code").getAbsolutePath().c_str(), file("raw/moved").getAbsolutePath().c_str()));
      put("code/a.R", "old");
   };
   const auto reply = write("code/a.R", hash("old"));
   EXPECT_EQ(400, reply.code) << "moved held parent refused beside rename";
   EXPECT_EQ("old", bytes("raw/moved/a.R")) << "directory reverify prevents write beneath raw";
   EXPECT_EQ("old", bytes("code/a.R"));
}

TEST_F(S10dDiskWrite, PrivateUntilRename)
{
   put("a.R"); ASSERT_EQ(0, ::chmod(file("a.R").getAbsolutePath().c_str(), 0644)); read("a.R");
   s_raiDiskAtRename = [&](const std::string& temp) {
      struct stat info;
      ASSERT_EQ(0, ::lstat(file(temp).getAbsolutePath().c_str(), &info));
      EXPECT_EQ(0600, info.st_mode & 07777) << "replacement bytes remain private through validation";
   };
   EXPECT_EQ(200, write("a.R", hash("old")).code);
   struct stat info;
   ASSERT_EQ(0, ::stat(file("a.R").getAbsolutePath().c_str(), &info));
   EXPECT_EQ(0644, info.st_mode & 07777);
}

TEST_F(S10dDiskWrite, Tokens)
{
   put("a.R");
   auto unread=write("a.R",hash("old")); EXPECT_EQ(400,unread.code) << "unread write refused";
   EXPECT_NE(std::string::npos,unread.body.find("read whole file first"));
   put("a.R"); read("a.R"); auto wrong=write("a.R",hash("wrong")); EXPECT_EQ(400,wrong.code) << "wrong digest refused";
   put("a.R"); read("a.R"); put("a.R","changed"); auto stale=write("a.R",hash("old"));
   EXPECT_EQ(400,stale.code) << "stale revision refused"; EXPECT_EQ("changed",bytes("a.R"));
   put("a.R",std::string(65537,'x'));
   ASSERT_EQ(200,post("/file","path=a.R").code);
   auto partial=write("a.R",hash(std::string(65537,'x')));
   EXPECT_EQ(400,partial.code) << "partial read cannot authorize";
   put("a.R",std::string(65537,'x')); read("a.R",65537); EXPECT_EQ(200,write("a.R",hash(std::string(65537,'x'))).code);
   read("a.R");
   const std::string key="disk:"+file("a.R").getCanonicalPath();
   s_raiReadTokens[key].digest=hash("wrong");
   EXPECT_EQ(400,write("a.R",hash("wrong")).code) << "current digest must equal expected digest";
   EXPECT_EQ("new",bytes("a.R")); noTemps();
}

TEST_F(S10dDiskWrite, Policy)
{
   for (const std::string path : {"data/a.R","Raw/a.py","reference/a.R","data-raw/a.R",".env",".Rprofile","a.yaml","a.json","a.unknown","a.csv.R","caf%C3%A9.R"})
   {
      if (path.find('%')==std::string::npos) put(path);
      auto reply=write(path,hash("old"));
      EXPECT_EQ(400,reply.code) << path;
      EXPECT_NE(std::string::npos,reply.body.find("code files only")) << "classifier precedes token " << path << reply.body;
   }
   put("a.R"); put("data/secret.R");
   ASSERT_EQ(0,::symlink(file("data/secret.R").getAbsolutePath().c_str(),file("linked.R").getAbsolutePath().c_str()));
   auto linked=write("linked.R",hash("old")); EXPECT_EQ(400,linked.code);
   EXPECT_NE(std::string::npos,linked.body.find("code files only")) << "realpath classifier deny wins";
   ASSERT_EQ(0,::symlink(file("data").getAbsolutePath().c_str(),file("alias").getAbsolutePath().c_str()));
   EXPECT_EQ(400,write("alias/secret.R",hash("old")).code);
   ASSERT_EQ(0,::link(file("a.R").getAbsolutePath().c_str(),file("hard.R").getAbsolutePath().c_str()));
   EXPECT_EQ(400,write("hard.R",hash("old")).code) << "hardlink refused";
   ASSERT_EQ(0,::unlink(file("hard.R").getAbsolutePath().c_str()));
   ASSERT_EQ(0,::symlink(file("a.R").getAbsolutePath().c_str(),file("leaf.R").getAbsolutePath().c_str()));
   read("a.R"); auto leaf=write("leaf.R",hash("old"));
   EXPECT_EQ(400,leaf.code) << "symlink leaf refused";
   EXPECT_NE(std::string::npos,leaf.body.find("non-symlink"));
   EXPECT_EQ(400,write("missing.R",hash("old")).code) << "no creation";
   EXPECT_FALSE(file("missing.R").exists());
   ASSERT_FALSE(file("directory.R").ensureDirectory()); EXPECT_EQ(400,write("directory.R",hash("old")).code);
   EXPECT_EQ(400,write("../outside.R",hash("old")).code);
   EXPECT_EQ(400,write("%2Fa.R",hash("old")).code); noTemps();
}

TEST_F(S10dDiskWrite, PayloadAndAuthentication)
{
   put("a.R"); read("a.R");
   EXPECT_EQ(401,write("a.R",hash("old"),std::string(4*1024*1024,'x')).code) << "encoded request including metadata exceeds 4 MiB";
   EXPECT_EQ(400,write("a.R",hash("old"),"%FF").code) << "invalid UTF-8 refused";
   EXPECT_EQ(400,write("a.R",hash("old"),"x%00y").code) << "NUL refused";
   EXPECT_EQ(400,post("/write","path=a.R&expected_digest="+hash("old")+"&contents=x&path=a.R").code);
   EXPECT_EQ(401,post("/write","path=a.R",false).code) << "peer proof required";
   http::Request request; request.setMethod("GET"); request.setUri("/write"); http::Response response;
   ASSERT_FALSE(handleWriteProjectFileRequest(request,&response)); EXPECT_EQ(405,response.statusCode());
   for (const auto& route : std::vector<std::pair<std::string,std::size_t>>{{"/write",4194304},{"/edit",4194304},{"/file",262144},{"/run",262144}})
   {
      for (std::size_t extra : {0U,1U})
      {
         http::Request capped; capped.setMethod("POST"); capped.setUri(route.first);
         capped.setBody(std::string(route.second+extra,'x'));
         raiSignCallbackForTests(&capped,s_sessionEndpointToken); http::Response admission;
         EXPECT_EQ(extra==0,verifyCallbackProof(capped,&admission)) << "native route-local encoded body cap " << route.first << " extra=" << extra;
         s_callbackFixtureRequests.erase(&capped);
      }
   }
   EXPECT_EQ("old",bytes("a.R")); noTemps();
}

TEST_F(S10dDiskWrite, OpenFile)
{
   put("a.R"); read("a.R");
   boost::shared_ptr<source_database::SourceDocument> doc(new source_database::SourceDocument("r_source"));
   json::Object meta; doc->writeToJson(&meta); meta["path"]=file("a.R").getAbsolutePath();
   ASSERT_FALSE(doc->readFromJson(&meta)); doc->setContents("unsaved");
   const FilePath record=source_database::path().completePath(doc->id());
   const FilePath sidecar=source_database::path().completePath(doc->id()+"-contents");
   BOOST_SCOPE_EXIT_ALL(&) { EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); };
   ASSERT_FALSE(doc->writeToFile(record));
   auto reply=write("a.R",hash("old")); EXPECT_EQ(400,reply.code) << "open file refused";
   EXPECT_NE(std::string::npos,reply.body.find("use edit_document"));
   EXPECT_EQ("old",bytes("a.R")); noTemps();
}

TEST_F(S10dDiskWrite, ConcurrentChange)
{
   put("a.R"); read("a.R");
   s_raiDiskBeforeCommit=[&]() { EXPECT_FALSE(writeStringToFile(file("a.R"),"external")); };
   auto reply=write("a.R",hash("old"));
   EXPECT_EQ(400,reply.code) << "concurrent content change refused"; EXPECT_EQ("external",bytes("a.R")); noTemps();
   s_raiDiskBeforeCommit=nullptr;
   put("a.R"); read("a.R");
   s_raiDiskBeforeCommit=[&]() {
      EXPECT_EQ(0,::unlink(file("a.R").getAbsolutePath().c_str()));
      EXPECT_FALSE(writeStringToFile(file("a.R"),"old"));
   };
   EXPECT_EQ(400,write("a.R",hash("old")).code) << "concurrent inode replacement refused";
   EXPECT_EQ("old",bytes("a.R")); noTemps();
   s_raiDiskBeforeCommit=nullptr; read("a.R");
   s_raiDiskBeforeCommit=[&]() { EXPECT_EQ(0,::unlink(file("a.R").getAbsolutePath().c_str())); };
   EXPECT_EQ(400,write("a.R",hash("old")).code) << "concurrent deletion never recreates";
   EXPECT_FALSE(file("a.R").exists()); noTemps();
}

TEST_F(S10dDiskWrite, NoFollow)
{
   put("a.R"); read("a.R");
   // Moving the same inode and replacing its old name with a link isolates
   // O_NOFOLLOW: fstat identity alone would still match the token.
   s_raiDiskBeforeOpen=[&]() {
      EXPECT_EQ(0,::rename(file("a.R").getAbsolutePath().c_str(),file("held.R").getAbsolutePath().c_str()));
      EXPECT_EQ(0,::symlink(file("held.R").getAbsolutePath().c_str(),file("a.R").getAbsolutePath().c_str()));
   };
   auto reply=write("a.R",hash("old"));
   EXPECT_EQ(400,reply.code);
   EXPECT_NE(std::string::npos,reply.body.find("file identity or contents changed")) << "O_NOFOLLOW rejects swapped leaf before token or trace";
   EXPECT_EQ("old",bytes("held.R")); noTemps();
   ASSERT_FALSE(r::exec::executeString("stopifnot(length(.s10d_trace_events)==0L)"));
}


TEST_F(S10dDiskWrite, ProjectAndParents)
{
   put("src/a.R");
   ASSERT_EQ(0,::symlink(file("src").getAbsolutePath().c_str(),file("alias").getAbsolutePath().c_str()));
   read("alias/a.R");
   EXPECT_EQ(200,write("alias/a.R",hash("old")).code) << "code parent symlink inside project allowed";
   EXPECT_EQ("new",bytes("src/a.R"));
   const FilePath outside=root.getParent().completePath(core::system::generateUuid(false));
   ASSERT_FALSE(outside.ensureDirectory());
   BOOST_SCOPE_EXIT_ALL(&) { EXPECT_FALSE(outside.removeIfExists()); };
   ASSERT_FALSE(writeStringToFile(outside.completePath("outside.R"),"external"));
   ASSERT_EQ(0,::symlink(outside.getAbsolutePath().c_str(),file("escape").getAbsolutePath().c_str()));
   auto escaped=write("escape/outside.R",hash("external"));
   EXPECT_EQ(400,escaped.code) << "symlink parent escape refused";
   EXPECT_NE(std::string::npos,escaped.body.find("inside the active project"));
   ASSERT_EQ(0,::symlink(file("src").getAbsolutePath().c_str(),file("data").getAbsolutePath().c_str()));
   EXPECT_EQ(400,write("data/a.R",hash("new")).code) << "original denied path wins over code realpath";
   s_raiDiskTestRoot=FilePath();
   if (!projects::projectContext().hasProject())
      EXPECT_EQ(400,write("src/a.R",hash("new")).code) << "no active project refused";
   s_raiDiskTestRoot=root; noTemps();
}

TEST_F(S10dDiskWrite, InvalidExistingContents)
{
   put("a.R",std::string("a\0b",3));
   EXPECT_EQ(400,post("/file","path=a.R").code);
   EXPECT_EQ(400,write("a.R",hash(std::string("a\0b",3))).code);
   put("a.R",std::string(1,static_cast<char>(0xff)));
   EXPECT_EQ(400,post("/file","path=a.R").code);
   EXPECT_EQ(400,write("a.R",hash(std::string(1,static_cast<char>(0xff)))).code);
   const std::string large(1048577,'x');
   put("a.R",large); read("a.R",large.size());
   EXPECT_EQ(200,write("a.R",hash(large)).code) << "completed code read above 1 MiB permits a disk replacement";
   EXPECT_EQ("new",bytes("a.R"));
   const std::string beyondReader(10*1024*1024+1,'x');
   put("a.R",beyondReader);
   EXPECT_EQ(400,post("/file","path=a.R").code) << "existing 10 MiB reader limit retained";
   RaiDiskFd held(::open(file("a.R").getAbsolutePath().c_str(),O_RDONLY|O_CLOEXEC));
   ASSERT_GE(held.fd,0); struct stat info; std::string snapshot;
   EXPECT_FALSE(raiDiskContents(held.fd,&snapshot,&info)) << "disk snapshots remain reader-bounded";
   EXPECT_EQ(400,write("a.R",hash(beyondReader)).code) << "oversized existing file refused";
   EXPECT_EQ(beyondReader,bytes("a.R")); noTemps();
}

TEST_F(S10dDiskWrite, ParentSwap)
{
   put("src/a.R"); read("src/a.R");
   s_raiDiskBeforeCommit=[&]() {
      EXPECT_EQ(0,::rename(file("src").getAbsolutePath().c_str(),file("moved").getAbsolutePath().c_str()));
      EXPECT_FALSE(file("src").ensureDirectory());
      EXPECT_FALSE(writeStringToFile(file("src/a.R"),"outside change"));
   };
   EXPECT_EQ(400,write("src/a.R",hash("old")).code) << "parent identity swap refused";
   EXPECT_EQ("old",bytes("moved/a.R")); EXPECT_EQ("outside change",bytes("src/a.R"));
   std::vector<FilePath> children; ASSERT_FALSE(file("moved").getChildren(children));
   ASSERT_EQ(1U,children.size()) << "temporary file cleaned in held directory"; noTemps();
}

TEST_F(S10dDiskWrite, TraceFailure)
{
   put("a.R"); read("a.R");
   ASSERT_FALSE(r::exec::executeString("assign('.rs.rai.traceDiskWrite', function(...) FALSE, as.environment('tools:rstudio'))"));
   EXPECT_EQ(400,write("a.R",hash("old")).code) << "trace failure blocks mutation";
   EXPECT_EQ("old",bytes("a.R")) << "trace failure blocks mutation: bytes unchanged"; noTemps();
   ASSERT_FALSE(r::exec::executeString("assign('.rs.rai.traceDiskWrite', function(event,...) event=='edit_apply_requested', as.environment('tools:rstudio'))"));
   auto completion=write("a.R",hash("old")); EXPECT_EQ(400,completion.code);
   EXPECT_NE(std::string::npos,completion.body.find("disk write occurred; completion unverified"));
   EXPECT_EQ("new",bytes("a.R"));
   EXPECT_EQ(400,write("a.R",hash("new")).code) << "completion failure cannot remint"; noTemps();
}
#endif

class S10dConnection : public HttpConnection
{
public:
   http::Request input;
   int code = 0;
   const http::Request& request() override { return input; }
   void sendResponse(const http::Response& value) override { code = value.statusCode(); }
   void sendJsonRpcResponse(core::json::JsonRpcResponse&) override {}
   void close() override {}
   std::string requestId() const override { return "s10d-route"; }
   void setUploadHandler(const http::UriAsyncUploadHandlerFunction&) override {}
   bool isAsyncRpc() const override { return false; }
   std::chrono::steady_clock::time_point receivedTime() const override { return std::chrono::steady_clock::now(); }
};
TEST(SessionRaiAssistant, S10dWriteRoute)
{
   class Listener : public RaiSessionEndpointListener { public: using RaiSessionEndpointListener::authenticate; } listener;
   boost::shared_ptr<S10dConnection> connection(new S10dConnection());
   connection->input.setMethod("POST"); connection->input.setUri("/write");
   EXPECT_TRUE(listener.authenticate(connection)) << "write route in outer allowlist";
   const std::string prior=s_sessionEndpointToken; s_sessionEndpointToken="s10d-route-token";
   BOOST_SCOPE_EXIT_ALL(&) { s_sessionEndpointToken=prior; };
   processSessionEndpointRequest(connection);
   EXPECT_EQ(401,connection->code) << "write dispatch requires peer proof";
   raiSignCallbackForTests(&connection->input,s_sessionEndpointToken);
   processSessionEndpointRequest(connection);
   EXPECT_EQ(400,connection->code) << "authenticated write reaches argument validator";
}

}}}} // owning module; no exported test API

namespace rstudio { namespace session { namespace modules { namespace rai_assistant {
namespace {
struct S11SavedFixture
{
   FilePath root, file, record, sidecar;
   boost::shared_ptr<source_database::SourceDocument> document;
   S11SavedFixture()
   {
      root = FilePath(core::system::getenv("TMPDIR")).completeChildPath(core::system::generateUuid(false));
      EXPECT_FALSE(root.ensureDirectory());
      EXPECT_FALSE(source_database::path().ensureDirectory());
      file = root.completeChildPath("analysis.R");
      EXPECT_FALSE(writeStringToFile(file, "x <- 1\n"));
      document.reset(new source_database::SourceDocument("r_source"));
      EXPECT_FALSE(document->setPathAndContents(file.getAbsolutePath()));
      document->setDirty(false);
      record = source_database::path().completePath(document->id());
      sidecar = source_database::path().completePath(document->id()+"-contents");
      EXPECT_FALSE(document->writeToFile(record));
      EXPECT_FALSE(r::exec::executeString("assign('.s11_old_trace', get('.rs.rai.traceDiskWrite', envir=as.environment('tools:rstudio')), .GlobalEnv); assign('.rs.rai.traceDiskWrite', function(...) TRUE, as.environment('tools:rstudio'))"));
      EXPECT_FALSE(r::exec::executeString("assign('.s11_old_save_auth', get0('.rs.rai.documentSaveAuthorized', envir=as.environment('tools:rstudio'), inherits=FALSE), .GlobalEnv); assign('.rs.rai.documentSaveAuthorized', function(...) TRUE, as.environment('tools:rstudio'))"));
   }
   ~S11SavedFixture()
   {
      EXPECT_FALSE(r::exec::executeString("if (is.null(.s11_old_save_auth)) rm('.rs.rai.documentSaveAuthorized', envir=as.environment('tools:rstudio')) else assign('.rs.rai.documentSaveAuthorized', .s11_old_save_auth, as.environment('tools:rstudio')); rm('.s11_old_save_auth', envir=.GlobalEnv)"));
      EXPECT_FALSE(r::exec::executeString("assign('.rs.rai.traceDiskWrite', .s11_old_trace, as.environment('tools:rstudio')); rm('.s11_old_trace', envir=.GlobalEnv)"));
      s_raiDocumentOperations.clear();
      EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); EXPECT_FALSE(root.removeIfExists());
   }
   RaiDocumentEditOutcome apply()
   {
      std::string digest;
      EXPECT_FALSE(core::system::crypto::sha256Hex(document->contents(), &digest));
      raiObserveRead("doc:"+document->id(), digest, "", 0, document->contents().size(), document->contents().size());
      auto& token = s_raiReadTokens.at("doc:"+document->id());
      token.diskPath = file.getAbsolutePath();
      EXPECT_TRUE(raiDocumentDiskSnapshot(token.diskPath, &token.diskBytes, &token.diskRevision));
      auto edit = raiApplyDocumentEdit(document->id(), "x <- 1", "x <- 2", "", "");
      edit.operationId = "s11-fixture";
      return edit;
   }
   void publish(RaiDocumentEditOutcome edit)
   {
      EXPECT_TRUE(edit.applied) << edit.failureReason;
      EXPECT_TRUE(raiPublishDocumentEdit(edit));
      RaiDocumentOperation operation; operation.edit = edit;
      s_raiDocumentOperations.emplace(edit.operationId, operation);
   }
   std::string disk() { std::string bytes; EXPECT_FALSE(readStringFromFile(file, &bytes)); return bytes; }
};
}
TEST(SessionRaiAssistant, S11SaveWritesActualDiskAndDuplicateAcknowledgementIsCached)
{
   S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
   EXPECT_EQ("x <- 1\n", fixture.disk()) << "save acknowledgement must follow disk write";
   auto result = raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents);
   EXPECT_TRUE(result["saved"].getBool()); EXPECT_EQ("x <- 2\n", fixture.disk()) << "S11 ack follows actual disk write";
   std::string bytes, revision, again;
   EXPECT_TRUE(raiDocumentDiskSnapshot(fixture.file.getAbsolutePath(), &bytes, &revision));
   auto duplicate = raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents);
   EXPECT_EQ(result.write(), duplicate.write()) << "S11 duplicate returns cached acknowledgement";
   EXPECT_TRUE(raiDocumentDiskSnapshot(fixture.file.getAbsolutePath(), &bytes, &again));
   EXPECT_EQ(revision, again) << "duplicate acknowledgement must not write twice";
   boost::shared_ptr<source_database::SourceDocument> latest(new source_database::SourceDocument());
   ASSERT_FALSE(source_database::get(fixture.document->id(), latest));
   EXPECT_FALSE(latest->dirty()); EXPECT_EQ(edit.newContents, latest->contents());
}
TEST(SessionRaiAssistant, S11ClientConflictPreservesDiskAndRestoresServerBuffer)
{
   S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
   auto result = raiAcknowledgeDocumentEdit(edit.operationId, false, "human typing");
   EXPECT_EQ("conflict", result["status"].getString()); EXPECT_FALSE(result["saved"].getBool());
   EXPECT_EQ("x <- 1\n", fixture.disk());
   boost::shared_ptr<source_database::SourceDocument> latest(new source_database::SourceDocument());
   ASSERT_FALSE(source_database::get(fixture.document->id(), latest)); EXPECT_EQ(edit.oldContents, latest->contents());
}
TEST(SessionRaiAssistant, S11ExternalChangeAtAcknowledgementNeverOverwrites)
{
   S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
   ASSERT_FALSE(writeStringToFile(fixture.file, "x <- 9\n"));
   auto result = raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents);
   EXPECT_FALSE(result["saved"].getBool()) << "S11 external change refuses save"; EXPECT_EQ("x <- 9\n", fixture.disk());
   EXPECT_NE(std::string::npos, result["message"].getString().find("Edit applied; file not saved:"));
}
TEST(SessionRaiAssistant, S11MissingBackupBlocksWorkingWrite)
{
   S11SavedFixture fixture; auto edit = fixture.apply();
   ASSERT_FALSE(FilePath(edit.backupPath).removeIfExists()); fixture.publish(edit);
   auto result = raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents);
   EXPECT_FALSE(result["saved"].getBool()); EXPECT_EQ("x <- 1\n", fixture.disk());
}
TEST(SessionRaiAssistant, S11ChangedEditorPostimageRefusesSave)
{
   S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
   auto result = raiAcknowledgeDocumentEdit(edit.operationId, true, "x <- 2\nhuman <- 3\n");
   EXPECT_FALSE(result["saved"].getBool()); EXPECT_EQ("x <- 1\n", fixture.disk());
}
TEST(SessionRaiAssistant, S11PreexistingDirtyStateIsNotAutomaticallySaved)
{
   S11SavedFixture fixture; fixture.document->setDirty(true); ASSERT_FALSE(fixture.document->writeToFile(fixture.record));
   auto edit = fixture.apply(); EXPECT_FALSE(edit.applied); EXPECT_EQ("x <- 1\n", fixture.disk());
}

TEST(SessionRaiAssistant, S11SavedRollbackRestoresDiskThroughCommonSave)
{
   S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
   auto result = raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents);
   ASSERT_TRUE(result["saved"].getBool());
   EXPECT_FALSE(raiRollbackDocumentEdit(edit)) << "rollback requires fresh editor postimage";
   EXPECT_EQ(edit.newContents, fixture.disk());
   EXPECT_TRUE(raiRollbackDocumentEdit(edit, edit.newContents));
   EXPECT_EQ(edit.oldContents, fixture.disk()) << "rollback must restore disk, not just buffer";
}
TEST(SessionRaiAssistant, S11SavedRollbackPreservesInterveningDiskChanges)
{
   S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
   ASSERT_TRUE(raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents)["saved"].getBool());
   ASSERT_FALSE(writeStringToFile(fixture.file, "human <- 3\n"));
   EXPECT_FALSE(raiRollbackDocumentEdit(edit, edit.newContents)); EXPECT_EQ("human <- 3\n", fixture.disk());
}
TEST(SessionRaiAssistant, S11StoredSaveSettingIsIgnoredAndEditIsSaved)
{
   const FilePath folder = core::system::userHomePath().completeChildPath(".raistudio");
   const FilePath config = folder.completeChildPath("assistant.json");
   ASSERT_FALSE(config.exists()); ASSERT_FALSE(folder.ensureDirectory());
   BOOST_SCOPE_EXIT_ALL(&) { EXPECT_FALSE(config.removeIfExists()); };
   for (const char* stored : {"{\"saveOnEdit\":false}", "{\"saveOnEdit\":\"false\"}", "{\"saveOnEdit\":0}",
                              "{\"saveOnEdit\":null}", "broken JSON"})
   {
      ASSERT_FALSE(writeStringToFile(config, stored));
      S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
      auto result = raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents);
      EXPECT_TRUE(result["saved"].getBool()) << "S11 stored " << stored << " is ignored: " << result.write();
      EXPECT_FALSE(result.hasMember("reason"));
      EXPECT_EQ(edit.newContents, fixture.disk());
   }
}
TEST(SessionRaiAssistant, S11InFlightOffIsIgnoredAndRollbackStillWorks)
{
   S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
   const FilePath folder = core::system::userHomePath().completeChildPath(".raistudio");
   const FilePath config = folder.completeChildPath("assistant.json");
   ASSERT_FALSE(config.exists()); ASSERT_FALSE(folder.ensureDirectory());
   ASSERT_FALSE(writeStringToFile(config, "{\"saveOnEdit\":false}"));
   BOOST_SCOPE_EXIT_ALL(&) { EXPECT_FALSE(config.removeIfExists()); };
   EXPECT_TRUE(raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents)["saved"].getBool()) << "S11 in-flight OFF does not refuse save";
   EXPECT_EQ(edit.newContents, fixture.disk());
   EXPECT_TRUE(raiRollbackDocumentEdit(edit, edit.newContents));
   EXPECT_EQ(edit.oldContents, fixture.disk()) << "S11 rollback is not gated by the retired key";
}

TEST(SessionRaiAssistant, S11WriteFailureRetainsDirtyStateAndIsNotReplayed)
{
   S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
   source::setRaiSaveFailureForTests(1);
   BOOST_SCOPE_EXIT_ALL(&) { source::setRaiSaveFailureForTests(0); };
   auto result = raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents);
   EXPECT_FALSE(result["saved"].getBool()); EXPECT_EQ(edit.oldContents, fixture.disk());
   source::setRaiSaveFailureForTests(0);
   EXPECT_EQ(result.write(), raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents).write());
   EXPECT_EQ(edit.oldContents, fixture.disk());
   boost::shared_ptr<source_database::SourceDocument> latest(new source_database::SourceDocument());
   ASSERT_FALSE(source_database::get(fixture.document->id(), latest)); EXPECT_TRUE(latest->dirty());
}
TEST(SessionRaiAssistant, S11WriteOkMetadataFailureNeverBlindlyReplaysOrClearsDirty)
{
   S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
   source::setRaiSaveFailureForTests(2);
   BOOST_SCOPE_EXIT_ALL(&) { source::setRaiSaveFailureForTests(0); };
   auto result = raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents);
   EXPECT_FALSE(result["saved"].getBool()); EXPECT_EQ(edit.newContents, fixture.disk());
   std::string bytes, revision, again;
   EXPECT_TRUE(raiDocumentDiskSnapshot(fixture.file.getAbsolutePath(), &bytes, &revision));
   source::setRaiSaveFailureForTests(0);
   EXPECT_EQ(result.write(), raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents).write());
   EXPECT_TRUE(raiDocumentDiskSnapshot(fixture.file.getAbsolutePath(), &bytes, &again)); EXPECT_EQ(revision, again);
   boost::shared_ptr<source_database::SourceDocument> latest(new source_database::SourceDocument());
   ASSERT_FALSE(source_database::get(fixture.document->id(), latest)); EXPECT_TRUE(latest->dirty()) << "S11 metadata failure retains dirty state";
}
TEST(SessionRaiAssistant, S11SaveSkipsSourceOnSaveNotificationsAndPreservesExactWhitespace)
{
   S11SavedFixture fixture;
   fixture.document->setSourceOnSave(true); ASSERT_FALSE(fixture.document->writeToFile(fixture.record));
   auto edit = fixture.apply(); fixture.publish(edit);
   int notifications = 0;
   auto connection = module_context::events().onSourceEditorFileSaved.connect([&](const FilePath&) { ++notifications; });
   BOOST_SCOPE_EXIT_ALL(&) { connection.disconnect(); };
   auto result = raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents);
   EXPECT_TRUE(result["saved"].getBool()) << "S11 exact bytes save succeeds without fixups"; EXPECT_EQ(0, notifications) << "source-on-save notification must be suppressed";
   EXPECT_EQ(edit.newContents, fixture.disk()) << "save must not run formatting or newline fixups";
   boost::shared_ptr<source_database::SourceDocument> latest(new source_database::SourceDocument());
   ASSERT_FALSE(source_database::get(fixture.document->id(), latest));
   EXPECT_EQ(fixture.file.getLastWriteTime(), latest->lastKnownWriteTime());
}
TEST(SessionRaiAssistant, S11ReplacedInodeWithIdenticalBytesIsConflict)
{
   S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
   const FilePath moved = fixture.root.completeChildPath("moved.R");
   ASSERT_FALSE(fixture.file.move(moved)); ASSERT_FALSE(writeStringToFile(fixture.file, edit.oldContents));
   EXPECT_FALSE(raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents)["saved"].getBool());
   EXPECT_EQ(edit.oldContents, fixture.disk());
}

TEST(SessionRaiAssistant, S11BackupCreationFailureRefusesBeforeApply)
{
   S11SavedFixture fixture;
   s_raiDocumentBackupFailure = true;
   BOOST_SCOPE_EXIT_ALL(&) { s_raiDocumentBackupFailure = false; };
   auto edit = fixture.apply(); EXPECT_FALSE(edit.applied);
   EXPECT_EQ("x <- 1\n", fixture.disk());
}
TEST(SessionRaiAssistant, S11PostPublicationIdentityClassifierAndClosureConflictsNeverSave)
{
   for (const std::string mode : {"closed", "type", "identity", "classifier", "human"})
   {
      SCOPED_TRACE(mode);
      S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
      boost::shared_ptr<source_database::SourceDocument> live(new source_database::SourceDocument());
      ASSERT_FALSE(source_database::get(fixture.document->id(), live));
      if (mode == "closed") ASSERT_FALSE(source_database::remove(live->id()));
      else
      {
         if (mode == "type") live->setType("text");
         if (mode == "identity" || mode == "classifier")
         {
            json::Object metadata; live->writeToJson(&metadata);
            if (mode == "identity") metadata["created"] = live->created() + 1;
            else metadata["path"] = fixture.root.completeChildPath("data/analysis.R").getAbsolutePath();
            ASSERT_FALSE(live->readFromJson(&metadata));
         }
         if (mode == "human") live->setContents("human typing");
         ASSERT_FALSE(source_database::put(live));
      }
      auto result = raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents);
      EXPECT_FALSE(result["saved"].getBool()); EXPECT_EQ(edit.oldContents, fixture.disk());
      if (mode == "human")
      { ASSERT_FALSE(source_database::get(fixture.document->id(), live)); EXPECT_EQ("human typing", live->contents()); }
   }
}
TEST(SessionRaiAssistant, S11MalformedSettingAtAcknowledgementIsIgnored)
{
   S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
   S11SettingsBackup settings; settings.put("broken JSON");
   auto result = raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents);
   EXPECT_TRUE(result["saved"].getBool()) << result.write(); EXPECT_EQ(edit.newContents, fixture.disk());
   EXPECT_FALSE(result.hasMember("reason"));
}
TEST(SessionRaiAssistant, S11RetiredApprovalBooleanCannotDisableSave)
{
   S11SettingsBackup settings; settings.put("{\"autoApproveReadOnly\":false}");
   S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
   EXPECT_TRUE(raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents)["saved"].getBool()) << "S11 retired approval cannot disable save";
   EXPECT_EQ(edit.newContents, fixture.disk());
}

TEST(SessionRaiAssistant, S11MissingAcknowledgementExpiresWithoutSaveOrLateReplay)
{
   S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
   auto& operation = s_raiDocumentOperations.at(edit.operationId);
   operation.started -= std::chrono::seconds(31);
   raiExpireDocumentAcknowledgement(&operation);
   ASSERT_TRUE(operation.settled); EXPECT_FALSE(operation.result["saved"].getBool());
   auto result = raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents);
   EXPECT_EQ("error", result["status"].getString()); EXPECT_FALSE(result["saved"].getBool());
   EXPECT_EQ(edit.oldContents, fixture.disk()) << "late acknowledgement must not start a save";
}

TEST(SessionRaiAssistant, S11AcknowledgementTimeoutReleasesMatchingBrokerRequest)
{
   S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
   const std::string documentId = json::Value(edit.documentId).write();
   const std::string scope = "local({";
   const std::string endScope = "}, new.env(parent=environment(get('.rs.rai.setDocumentEditOutcome', as.environment('tools:rstudio')))))";
   const std::string key = "key <- .rs.rai.requestKey('edit_document', list(path=" + documentId + ", domain='r'));";
   ASSERT_FALSE(r::exec::executeString(scope + key +
      "stopifnot(!exists(key, .rs.rai.grantState$requests, inherits=FALSE));"
      "assign(key, list(requestId='s11-fixture', tool='edit_document', target=list(path=" + documentId +
      ", domain='r'), decision='applying', digest='timeout-control'), .rs.rai.grantState$requests)" + endScope));
   BOOST_SCOPE_EXIT_ALL(&) {
      EXPECT_FALSE(r::exec::executeString(scope + key +
         "if (exists(key, .rs.rai.grantState$requests, inherits=FALSE)) rm(list=key, envir=.rs.rai.grantState$requests)" + endScope));
   };
   const std::string proposal = "reply <- .rs.rai.requestApproval('edit_document', 'timeout recovery control', list(path=" +
      documentId + ", domain='r'), preview='fresh distinct code edit', digestPayload='fresh-timeout-control', autoApprove=TRUE);";
   ASSERT_FALSE(r::exec::executeString(scope + proposal +
      "stopifnot(identical(reply, 'blocked: document edit is already applying'))" + endScope));
   auto& operation = s_raiDocumentOperations.at(edit.operationId);
   operation.started -= std::chrono::seconds(31);
   raiExpireDocumentAcknowledgement(&operation);
   ASSERT_TRUE(operation.settled);
   EXPECT_FALSE(r::exec::executeString(scope + key +
      "stopifnot(identical(get(key, .rs.rai.grantState$requests)$decision, 'failed'))" + endScope))
      << "native timeout must settle the matching R request, not leave the document permanently busy";
   EXPECT_FALSE(r::exec::executeString(scope + proposal +
      "stopifnot(!identical(reply, 'blocked: document edit is already applying'))" + endScope))
      << "a fresh distinct proposal must reach ordinary authorization checks";
   auto late = raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents);
   EXPECT_EQ("error", late["status"].getString());
   EXPECT_FALSE(late["saved"].getBool());
   EXPECT_EQ(edit.oldContents, fixture.disk()) << "broker recovery never replays a save";
}

TEST(SessionRaiAssistant, S11TerminalOperationsReleaseHeavyPayloadsAndPreserveReplayAndRollback)
{
   for (const std::string terminal : {"saved", "conflict", "timeout"})
   {
      SCOPED_TRACE(terminal);
      S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
      auto& operation = s_raiDocumentOperations.at(edit.operationId);
      ASSERT_TRUE(operation.edit.document);
      ASSERT_EQ(edit.oldContents, operation.edit.oldContents);
      json::Object result;
      if (terminal == "timeout")
      {
         operation.started -= std::chrono::seconds(31);
         raiExpireDocumentAcknowledgement(&operation);
         result = operation.result;
      }
      else
         result = raiAcknowledgeDocumentEdit(edit.operationId, terminal == "saved", edit.newContents);
      ASSERT_TRUE(operation.settled);
      EXPECT_EQ(terminal == "saved", result["saved"].getBool());
      EXPECT_TRUE(operation.edit.oldContents.empty()) << "terminal history must release old source bytes";
      EXPECT_TRUE(operation.edit.newContents.empty()) << "terminal history must release new source bytes";
      EXPECT_TRUE(operation.edit.diskBytes.empty()) << "terminal history must release the disk preimage";
      EXPECT_TRUE(operation.edit.postimageMetadata.empty()) << "terminal history must release serialized document contents";
      EXPECT_LE(operation.edit.postimageMetadata.capacity(), std::string().capacity())
         << "clearing text without releasing its heap allocation is not compaction";
      EXPECT_FALSE(operation.edit.document) << "terminal history must not retain a document object";
      const std::string cached = operation.result.write();
      EXPECT_EQ(cached, raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents).write())
         << "compaction must preserve duplicate acknowledgement results without replay";
      if (terminal == "saved")
      {
         EXPECT_EQ(edit.newContents, fixture.disk());
         EXPECT_FALSE(operation.savedRevision.empty());
         EXPECT_TRUE(raiRollbackDocumentEdit(edit, edit.newContents))
            << "supported acknowledged rollback retains its exact saved-revision authority";
         EXPECT_EQ(edit.oldContents, fixture.disk());
      }
      else
         EXPECT_EQ(edit.oldContents, fixture.disk()) << "conflict/timeout never saves";
   }
}
}}}}

namespace rstudio { namespace session { namespace modules { namespace rai_assistant {
namespace {
void stubDocumentEditBroker(const std::string& peekBody)
{
   ASSERT_FALSE(r::exec::executeString(
      "assign('.rai_saved_queue_edit', get0('.rs.rai.queueDocumentEdit', envir=as.environment('tools:rstudio'), inherits=FALSE), .GlobalEnv); "
      "assign('.rai_saved_peek_edit', get0('.rs.rai.peekDocumentEditStatus', envir=as.environment('tools:rstudio'), inherits=FALSE), .GlobalEnv); "
      "assign('.rai_queue_edit_calls', 0L, .GlobalEnv); assign('.rai_peek_edit_calls', 0L, .GlobalEnv); "
      "assign('.rs.rai.queueDocumentEdit', function(...) { .rai_queue_edit_calls <<- .rai_queue_edit_calls + 1L; list(status='applying',approval='autonomous') }, as.environment('tools:rstudio')); "
      "assign('.rs.rai.peekDocumentEditStatus', function(...) { .rai_peek_edit_calls <<- .rai_peek_edit_calls + 1L; " + peekBody + " }, as.environment('tools:rstudio'))"));
}
void restoreDocumentEditBroker()
{
   EXPECT_FALSE(r::exec::executeString(
      "if (is.null(.rai_saved_queue_edit)) rm('.rs.rai.queueDocumentEdit', envir=as.environment('tools:rstudio')) else assign('.rs.rai.queueDocumentEdit', .rai_saved_queue_edit, as.environment('tools:rstudio')); "
      "if (is.null(.rai_saved_peek_edit)) rm('.rs.rai.peekDocumentEditStatus', envir=as.environment('tools:rstudio')) else assign('.rs.rai.peekDocumentEditStatus', .rai_saved_peek_edit, as.environment('tools:rstudio')); "
      "rm(list=c('.rai_saved_queue_edit','.rai_saved_peek_edit','.rai_queue_edit_calls','.rai_peek_edit_calls'), envir=.GlobalEnv)"));
}
int documentBrokerCallCount(const char* name)
{
   int value = -1;
   EXPECT_FALSE(r::exec::RFunction("get", name).call(&value));
   return value;
}
}

TEST(SessionRaiAssistant, CachedAppliedResultRequiresPostimageInBuffer)
{
   const FilePath database = source_database::path();
   ASSERT_EQ(core::system::getenv("HOME"), core::system::getenv("TMPDIR"));
   ASSERT_FALSE(database.ensureDirectory());
   const std::string prior = s_sessionEndpointToken;
   s_sessionEndpointToken = "cached-applied-token";
   boost::shared_ptr<source_database::SourceDocument> doc(new source_database::SourceDocument("r_source"));
   doc->setContents("old");
   const FilePath record = database.completePath(doc->id()), sidecar = database.completePath(doc->id()+"-contents");
   ASSERT_FALSE(record.exists()); ASSERT_FALSE(sidecar.exists());
   BOOST_SCOPE_EXIT_ALL(&) { s_sessionEndpointToken = prior; s_raiReadTokens.clear(); EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); };
   ASSERT_FALSE(doc->writeToFile(record));
   stubDocumentEditBroker("list(status='applied', document_id='cached')");
   BOOST_SCOPE_EXIT_ALL(&) { restoreDocumentEditBroker(); };
   auto post = [&](const std::string& body) {
      http::Request req; req.setMethod("POST"); req.setUri("/edit"); req.setHeader("X-RAI-Bridge-Token", s_sessionEndpointToken); req.setBody(body);
      http::Response res; EXPECT_FALSE(invokeDocumentProven(handleDocumentEditRequest, req, &res));
      struct Reply { int code; std::string text; int statusCode() const { return code; } const std::string& body() const { return text; } };
      return Reply{res.statusCode(), res.body()};
   };
   http::Request read; read.setMethod("POST"); read.setUri("/document");
   read.setHeader("X-RAI-Bridge-Token", s_sessionEndpointToken); read.setBody("document_id=" + doc->id());
   http::Response readResponse; ASSERT_FALSE(invokeDocumentProven(handleOpenDocumentRequest, read, &readResponse));
   ASSERT_EQ(200, readResponse.statusCode());
   const std::string body = "document_id=" + doc->id() + "&expected_text=old&replacement=new";
   auto fresh = post(body);
   EXPECT_EQ(200, fresh.statusCode()) << fresh.body();
   EXPECT_NE(std::string::npos, fresh.body().find("applying")) << "buffer without the postimage must not replay a cached applied result";
   EXPECT_EQ(1, documentBrokerCallCount(".rai_queue_edit_calls"));
   doc->setContents("new"); ASSERT_FALSE(doc->writeToFile(record));
   auto cached = post(body);
   EXPECT_EQ(200, cached.statusCode()) << cached.body();
   EXPECT_NE(std::string::npos, cached.body().find("applied")) << "buffer holding the postimage still answers from the cache";
   EXPECT_EQ(1, documentBrokerCallCount(".rai_queue_edit_calls"));
}

TEST(SessionRaiAssistant, SnippetFieldsRejectNulBeforeAnyRCall)
{
   const FilePath database = source_database::path();
   ASSERT_EQ(core::system::getenv("HOME"), core::system::getenv("TMPDIR"));
   ASSERT_FALSE(database.ensureDirectory());
   const std::string prior = s_sessionEndpointToken;
   s_sessionEndpointToken = "nul-fields-token";
   boost::shared_ptr<source_database::SourceDocument> doc(new source_database::SourceDocument("r_source"));
   doc->setContents("old");
   const FilePath record = database.completePath(doc->id()), sidecar = database.completePath(doc->id()+"-contents");
   ASSERT_FALSE(record.exists()); ASSERT_FALSE(sidecar.exists());
   BOOST_SCOPE_EXIT_ALL(&) { s_sessionEndpointToken = prior; s_raiReadTokens.clear(); EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); };
   ASSERT_FALSE(doc->writeToFile(record));
   stubDocumentEditBroker("NULL");
   BOOST_SCOPE_EXIT_ALL(&) { restoreDocumentEditBroker(); };
   const std::string id = "document_id=" + doc->id();
   for (const std::string& body : {
           id + "&expected_text=old%00&replacement=new",
           id + "&expected_text=old&replacement=n%00ew",
           id + "&expected_text=old&replacement=new&context_before=a%00&context_after=b",
           id + "&expected_text=old&replacement=new&context_before=a&context_after=%ffb",
           id + "&expected_digest=" + std::string(63, 'a') + "%00&contents=new"})
   {
      SCOPED_TRACE(body);
      http::Request req; req.setMethod("POST"); req.setUri("/edit"); req.setHeader("X-RAI-Bridge-Token", s_sessionEndpointToken);
      req.setBody(body);
      http::Response res; ASSERT_FALSE(invokeDocumentProven(handleDocumentEditRequest, req, &res));
      EXPECT_EQ(400, res.statusCode()) << res.body();
      EXPECT_EQ(0, documentBrokerCallCount(".rai_peek_edit_calls"));
      EXPECT_EQ(0, documentBrokerCallCount(".rai_queue_edit_calls"));
   }
}

TEST(SessionRaiAssistant, CrlfAndLatin1BuffersEditInTheEditorOnly)
{
   for (const std::string mode : {"crlf", "lone-cr", "separator", "bom", "latin1"})
   {
      SCOPED_TRACE(mode);
      S11SavedFixture fixture;
      std::string disk, buffer = "x <- 1\n";
      if (mode == "crlf") disk = "x <- 1\r\n";
      else if (mode == "lone-cr") disk = "x <- 1\r";
      else if (mode == "separator") disk = "x <- 1\xE2\x80\xA8";
      else if (mode == "bom") disk = "\xEF\xBB\xBFx <- 1\n";
      else { disk = "x <- 1 # caf\xE9\n"; buffer = "x <- 1 # caf\xC3\xA9\n"; }
      ASSERT_FALSE(writeStringToFile(fixture.file, disk));
      if (mode == "latin1")
      {
         fixture.document->setEncoding("ISO-8859-1"); fixture.document->setContents(buffer);
      }
      else
      {
         ASSERT_FALSE(fixture.document->setPathAndContents(fixture.file.getAbsolutePath()));
         ASSERT_EQ(buffer, fixture.document->contents());
      }
      fixture.document->setDirty(false); ASSERT_FALSE(fixture.document->writeToFile(fixture.record));
      std::string digest;
      ASSERT_FALSE(core::system::crypto::sha256Hex(fixture.document->contents(), &digest));
      raiObserveRead("doc:" + fixture.document->id(), digest, "", 0, buffer.size(), buffer.size());
      auto& token = s_raiReadTokens.at("doc:" + fixture.document->id());
      token.diskPath = fixture.file.getAbsolutePath();
      if (!raiDocumentDiskSnapshot(token.diskPath, &token.diskBytes, &token.diskRevision)) token.diskRevision.clear();
      auto edit = raiApplyDocumentEdit(fixture.document->id(), "x <- 1", "x <- 2", "", "");
      edit.operationId = "editor-only-edit";
      ASSERT_TRUE(edit.applied) << edit.failureReason;
      EXPECT_FALSE(edit.noSaveReason.empty());
      EXPECT_TRUE(edit.backupPath.empty()) << "editor-only edits never write a disk backup";
      fixture.publish(edit);
      auto result = raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents);
      EXPECT_FALSE(result["saved"].getBool());
      EXPECT_NE(std::string::npos, result["message"].getString().find("Edit applied; file not saved:"));
      EXPECT_EQ(disk, fixture.disk()) << "the file on disk stays byte for byte unchanged";
      boost::shared_ptr<source_database::SourceDocument> latest(new source_database::SourceDocument());
      ASSERT_FALSE(source_database::get(fixture.document->id(), latest));
      EXPECT_EQ(edit.newContents, latest->contents()); EXPECT_TRUE(latest->dirty());
   }
}

TEST(SessionRaiAssistant, ChangedUtf8FileStillFailsIdentityCheck)
{
   S11SavedFixture fixture;
   std::string digest;
   ASSERT_FALSE(core::system::crypto::sha256Hex(fixture.document->contents(), &digest));
   raiObserveRead("doc:" + fixture.document->id(), digest, "", 0, fixture.document->contents().size(), fixture.document->contents().size());
   auto& token = s_raiReadTokens.at("doc:" + fixture.document->id());
   token.diskPath = fixture.file.getAbsolutePath();
   ASSERT_TRUE(raiDocumentDiskSnapshot(token.diskPath, &token.diskBytes, &token.diskRevision));
   ASSERT_FALSE(writeStringToFile(fixture.file, "x <- 9\n"));
   auto edit = raiApplyDocumentEdit(fixture.document->id(), "x <- 1", "x <- 2", "", "");
   EXPECT_FALSE(edit.applied);
   EXPECT_EQ("disk identity or contents changed since the authorized read", edit.failureReason);
}

TEST(SessionRaiAssistant, OtherDocumentEventDoesNotInvalidateTheSave)
{
   for (const bool sameDocument : {false, true})
   {
      SCOPED_TRACE(sameDocument);
      S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
      boost::shared_ptr<source_database::SourceDocument> other(new source_database::SourceDocument("r_source"));
      other->setContents("other");
      const FilePath record = source_database::path().completePath(other->id());
      const FilePath sidecar = source_database::path().completePath(other->id() + "-contents");
      BOOST_SCOPE_EXIT_ALL(&) { EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); };
      ASSERT_FALSE(other->writeToFile(record));
      if (sameDocument)
      {
         boost::shared_ptr<source_database::SourceDocument> live(new source_database::SourceDocument());
         ASSERT_FALSE(source_database::get(fixture.document->id(), live));
         source_database::events().onDocUpdated(live);
      }
      else
         source_database::events().onDocUpdated(other);
      auto result = raiAcknowledgeDocumentEdit(edit.operationId, true, edit.newContents);
      EXPECT_EQ(!sameDocument, result["saved"].getBool()) << result.write();
      EXPECT_EQ(sameDocument ? edit.oldContents : edit.newContents, fixture.disk());
   }
}

TEST(SessionRaiAssistant, ConflictReportsAFailedRollbackHonestly)
{
   S11SavedFixture fixture; auto edit = fixture.apply(); fixture.publish(edit);
   boost::shared_ptr<source_database::SourceDocument> live(new source_database::SourceDocument());
   ASSERT_FALSE(source_database::get(fixture.document->id(), live));
   source_database::events().onDocUpdated(live);
   auto result = raiAcknowledgeDocumentEdit(edit.operationId, false, "human typing");
   EXPECT_EQ("conflict", result["status"].getString());
   EXPECT_EQ(std::string::npos, result["message"].getString().find("Human buffer preserved"));
   EXPECT_NE(std::string::npos, result["message"].getString().find("could not be restored"));
}

#ifndef _WIN32
TEST_F(S10dDiskWrite, StaleOpenTabDoesNotBlockWrites)
{
   put("a.R"); read("a.R");
   boost::shared_ptr<source_database::SourceDocument> doc(new source_database::SourceDocument("r_source"));
   json::Object meta; doc->writeToJson(&meta); meta["path"] = file("gone.R").getAbsolutePath();
   ASSERT_FALSE(doc->readFromJson(&meta)); doc->setContents("stale tab");
   const FilePath record = source_database::path().completePath(doc->id());
   const FilePath sidecar = source_database::path().completePath(doc->id() + "-contents");
   BOOST_SCOPE_EXIT_ALL(&) { EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); };
   ASSERT_FALSE(doc->writeToFile(record));
   ASSERT_FALSE(file("gone.R").exists());
   auto reply = write("a.R", hash("old"));
   EXPECT_EQ(200, reply.code) << reply.body;
   EXPECT_EQ("new", bytes("a.R")); noTemps();
}

TEST_F(S10dDiskWrite, UnreadableOpenTabPathFailsClosed)
{
   put("a.R"); read("a.R"); put("locked/b.R");
   boost::shared_ptr<source_database::SourceDocument> doc(new source_database::SourceDocument("r_source"));
   json::Object meta; doc->writeToJson(&meta); meta["path"] = file("locked/b.R").getAbsolutePath();
   ASSERT_FALSE(doc->readFromJson(&meta)); doc->setContents("locked tab");
   const FilePath record = source_database::path().completePath(doc->id());
   const FilePath sidecar = source_database::path().completePath(doc->id() + "-contents");
   const std::string locked = file("locked").getAbsolutePath();
   BOOST_SCOPE_EXIT_ALL(&) { ::chmod(locked.c_str(), 0700); EXPECT_FALSE(record.removeIfExists()); EXPECT_FALSE(sidecar.removeIfExists()); };
   ASSERT_FALSE(doc->writeToFile(record));
   ASSERT_EQ(0, ::chmod(locked.c_str(), 0));
   if (::geteuid() == 0) return;
   auto reply = write("a.R", hash("old"));
   EXPECT_EQ(400, reply.code) << reply.body;
   EXPECT_NE(std::string::npos, reply.body.find("could not verify open document identity"));
   EXPECT_EQ("old", bytes("a.R")); noTemps();
}
#endif
}}}}
