/*
 * SessionSource.hpp
 *
 * Copyright (C) 2022 by Posit Software, PBC
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

#ifndef SESSION_SOURCE_HPP
#define SESSION_SOURCE_HPP

#include <vector>

#include <boost/shared_ptr.hpp>
#include <boost/function.hpp>
#include <session/SessionSourceDatabase.hpp>

#include <shared_core/json/Json.hpp>

namespace rstudio {
namespace core {
   class Error;
   namespace r_util {
      class RSourceIndex;
   }
}
}
 
namespace rstudio {
namespace session {
namespace modules { 
namespace source {
   
core::Error clientInitDocuments(core::json::Array* pJsonDocs);

#ifdef RSTUDIO_UNIT_TESTS_ENABLED
void setRaiSaveFailureForTests(int mode);
#endif

core::Error saveRaiDocument(boost::shared_ptr<source_database::SourceDocument> document,
                            const std::string& contents,
                            const boost::function<core::Error()>& beforeWrite);

core::Error initialize();
                       
} // namespace source
} // namespace modules
} // namespace session
} // namespace rstudio

#endif // SESSION_SOURCE_HPP
