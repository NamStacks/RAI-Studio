# Pinned language-server 1.509.1 / embedded @github/copilot 1.0.63 only.
# Install-time metadata repair, never run against the dependency producer.
# Keep the CommonJS package boundary and every vendor code byte unchanged.
cmake_minimum_required(VERSION 3.19)

function(rai_copilot_sdk_module_format root)
   set(pkg "${root}/node_modules/@github/copilot")
   foreach(path "${root}" "${root}/node_modules" "${root}/node_modules/@github"
                "${pkg}" "${pkg}/sdk" "${pkg}/sdk/worker")
      if(IS_SYMLINK "${path}" OR NOT IS_DIRECTORY "${path}")
         message(FATAL_ERROR "Copilot SDK repair: invalid physical directory ${path}")
      endif()
   endforeach()
   # Unknown metadata in the retained closure can alter helper/caller scope.
   foreach(path "${root}/package.json" "${root}/node_modules/package.json"
                "${root}/node_modules/@github/package.json" "${pkg}/sdk/package.json"
                "${pkg}/sdk/worker/package.json")
      if(EXISTS "${path}" OR IS_SYMLINK "${path}")
         message(FATAL_ERROR "Copilot SDK repair: unexpected package boundary ${path}")
      endif()
   endforeach()
   set(inputs
      "language-server.js|fe7672c83c20a0c6012657d22f385fe30ce8fe2e25f5e4fd765a7dc5d7cf60f1"
      "main.js|e3bd3e874aa483d87f3931a417b5b3df412cd179ed95a084239de34ceacc31fd"
      "node_modules/@github/copilot/sdk/index.js|da411a55d13b9d568c39f320bbe61389548fc98351bf91d5d42b8ba27b67472a"
      "node_modules/@github/copilot/sdk/index.cjs|a179fb1c1ee6ecf3ed97af183c733a9a8e021aa7755119aea4467f742bb392c0"
      "node_modules/@github/copilot/sdk/worker/conoutSocketWorker.js|47bf56e4fed56e5dddb68c0b24807d1e13dcc0381cb3b2f7a4c64f8a30aa3bf5"
      "node_modules/@github/copilot/sdk/conpty_console_list_agent.js|aa939018667d081e70b55398f764557d14a81ba2f9937369722c58d91a6e35d7")
   foreach(input IN LISTS inputs)
      string(REPLACE "|" ";" fields "${input}")
      list(GET fields 0 name)
      list(GET fields 1 expected)
      if(IS_SYMLINK "${root}/${name}" OR IS_DIRECTORY "${root}/${name}" OR NOT EXISTS "${root}/${name}")
         message(FATAL_ERROR "Copilot SDK repair: missing/invalid input ${name}")
      endif()
      file(SHA256 "${root}/${name}" actual)
      if(NOT actual STREQUAL expected)
         message(FATAL_ERROR "Copilot SDK repair: unknown pinned input ${name}")
      endif()
   endforeach()
   set(manifest "${pkg}/package.json")
   set(target "${pkg}/sdk/index.mjs")
   if(IS_SYMLINK "${manifest}" OR IS_DIRECTORY "${manifest}" OR NOT EXISTS "${manifest}")
      message(FATAL_ERROR "Copilot SDK repair: invalid manifest")
   endif()
   file(SHA256 "${manifest}" manifest_hash)
   set(original "a28cdbab45157693a0ca6886b5c2cb1ab966ee0ced9e592f428d5cf635541fe9")
   set(derived "e4c0033593729b4316a8d8eada15b9a34c0b2c9889f10ee2f93f13e019ece844")
   if(IS_SYMLINK "${target}" OR IS_DIRECTORY "${target}")
      message(FATAL_ERROR "Copilot SDK repair: unexpected target")
   endif()
   if(manifest_hash STREQUAL derived)
      # Idempotency is admitted only for the exact fully repaired state.
      if(NOT EXISTS "${target}")
         message(FATAL_ERROR "Copilot SDK repair: incomplete derived state")
      endif()
      file(SHA256 "${target}" target_hash)
      if(NOT target_hash STREQUAL "da411a55d13b9d568c39f320bbe61389548fc98351bf91d5d42b8ba27b67472a")
         message(FATAL_ERROR "Copilot SDK repair: altered derived target")
      endif()
      return()
   endif()
   if(NOT manifest_hash STREQUAL original)
      message(FATAL_ERROR "Copilot SDK repair: unknown package metadata")
   endif()
   if(EXISTS "${target}")
      # A prior install may have left the exact alias when DIRECTORY recopies
      # original metadata. Admit that known state, without overwriting it.
      file(SHA256 "${target}" target_hash)
      if(NOT target_hash STREQUAL "da411a55d13b9d568c39f320bbe61389548fc98351bf91d5d42b8ba27b67472a")
         message(FATAL_ERROR "Copilot SDK repair: unexpected existing target")
      endif()
   endif()
   # All qualification precedes any write. COPYONLY retains source permissions.
   file(READ "${manifest}" metadata)
   string(REPLACE "\"import\": \"./sdk/index.js\"" "\"import\": \"./sdk/index.mjs\"" metadata "${metadata}")
   string(SHA256 metadata_hash "${metadata}")
   if(NOT metadata_hash STREQUAL derived)
      message(FATAL_ERROR "Copilot SDK repair: unexpected metadata transformation")
   endif()
   if(NOT EXISTS "${target}")
      configure_file("${pkg}/sdk/index.js" "${target}" COPYONLY)
   endif()
   file(WRITE "${manifest}" "${metadata}")
endfunction()

if(DEFINED RAI_COPILOT_ROOT)
   rai_copilot_sdk_module_format("${RAI_COPILOT_ROOT}")
endif()
