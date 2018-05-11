// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

module.exports = function(code) {
  if (code >= 100 && code < 200) {
    return '1xx';
  } if (code >= 200 && code < 300) {
    return '2xx';
  } else if (code >= 300 && code < 400) {
    return '3xx';
  } else if (code >= 400 && code < 500) {
    return '4xx';
  } else {
    return '5xx';
  }
};
