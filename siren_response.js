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

module.exports = function(res, code, json) {
  if (typeof json === 'object' && !Buffer.isBuffer(json)) {
    try {
      var bodyText = JSON.stringify(json);
    } catch(err) {
      console.error('JSON.stringify:', err);
      res.statusCode = 500;
      res.end();
      return;
    }
  } else {
    var bodyText = json;
  }

  res.statusCode = code;
  res.setHeader('Content-Type', 'application/vnd.siren+json');
  res.setHeader('Content-Length', bodyText.length);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(bodyText);
}
