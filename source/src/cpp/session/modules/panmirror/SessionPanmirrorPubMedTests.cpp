#include "SessionPanmirrorPubMedResponse.hpp"
#include <gtest/gtest.h>

namespace rstudio {
namespace session {
namespace modules {
namespace panmirror {
namespace pubmed {

TEST(PubMedESearchResponse, Http500IsTransientNotEmpty)
{
   EXPECT_EQ(SearchResponse::TransientFailure,
             classifySearchResponse("", "HTTP status was '500 Internal Server Error'"));
}

TEST(PubMedESearchResponse, Http200EmbeddedXmlBackendErrorIsTransient)
{
   EXPECT_EQ(SearchResponse::TransientFailure,
             classifySearchResponse("<eSearchResult><ERROR>Search Backend failed: "
                                    "Search is temporarily unavailable. "
                                    "Cannot connect to SOLR</ERROR></eSearchResult>", ""));
}

TEST(PubMedESearchResponse, Http200EmbeddedJsonBackendErrorIsTransient)
{
   EXPECT_EQ(SearchResponse::TransientFailure,
             classifySearchResponse("{\"esearchresult\":{\"ERROR\":\"Search Backend failed: "
                                    "temporarily unavailable\"}}", ""));
}

TEST(PubMedESearchResponse, EmptyIsNotAnError)
{
   EXPECT_EQ(SearchResponse::Empty,
             classifySearchResponse("{\"esearchresult\":{\"count\":\"0\",\"idlist\":[]}}", ""));
}

TEST(PubMedESearchResponse, ResultsRequireRealPubMedIds)
{
   EXPECT_EQ(SearchResponse::Results,
             classifySearchResponse("{\"esearchresult\":{\"count\":\"1\",\"idlist\":[\"12345\"]}}", ""));
   EXPECT_EQ(SearchResponse::Invalid,
             classifySearchResponse("{\"esearchresult\":{\"count\":\"1\"}}", ""));
}

} // namespace pubmed
} // namespace panmirror
} // namespace modules
} // namespace session
} // namespace rstudio
