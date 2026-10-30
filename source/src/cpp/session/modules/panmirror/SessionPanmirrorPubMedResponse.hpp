#ifndef SESSION_PANMIRROR_PUBMED_RESPONSE_HPP
#define SESSION_PANMIRROR_PUBMED_RESPONSE_HPP

#include <string>
#include <shared_core/json/Json.hpp>

namespace rstudio {
namespace session {
namespace modules {
namespace panmirror {
namespace pubmed {

// Classify only PubMed ESearch responses. In particular, an HTTP 200 with
// <ERROR> or esearchresult.ERROR is not an empty PubMed search.
enum class SearchResponse { Results, Empty, TransientFailure, Invalid };

inline SearchResponse classifySearchResponse(const std::string& body,
                                             const std::string& stderrText)
{
   if (stderrText.find("500 Internal Server Error") != std::string::npos ||
       stderrText.find("502 Bad Gateway") != std::string::npos ||
       stderrText.find("503 Service Unavailable") != std::string::npos ||
       stderrText.find("504 Gateway Timeout") != std::string::npos ||
       stderrText.find("HTTP status was '500") != std::string::npos ||
       stderrText.find("HTTP status was '502") != std::string::npos ||
       stderrText.find("HTTP status was '503") != std::string::npos ||
       stderrText.find("HTTP status was '504") != std::string::npos)
      return SearchResponse::TransientFailure;

   if (body.find("<ERROR>") != std::string::npos &&
       (body.find("Search Backend failed") != std::string::npos ||
        body.find("temporarily unavailable") != std::string::npos))
      return SearchResponse::TransientFailure;

   core::json::Value value;
   if (value.parse(body) || !value.isObject())
      return SearchResponse::Invalid;
   core::json::Object object = value.getObject();
   if (!object.hasMember("esearchresult") || !object["esearchresult"].isObject())
      return SearchResponse::Invalid;
   core::json::Object search = object["esearchresult"].getObject();
   if (search.hasMember("ERROR"))
   {
      if (search["ERROR"].isString())
      {
         std::string detail = search["ERROR"].getString();
         if (detail.find("Search Backend failed") != std::string::npos ||
             detail.find("temporarily unavailable") != std::string::npos)
            return SearchResponse::TransientFailure;
      }
      return SearchResponse::Invalid;
   }
   if (!search.hasMember("idlist") || !search["idlist"].isArray())
      return SearchResponse::Invalid;
   return search["idlist"].getArray().getSize() == 0 ?
      SearchResponse::Empty : SearchResponse::Results;
}

} // namespace pubmed
} // namespace panmirror
} // namespace modules
} // namespace session
} // namespace rstudio

#endif
