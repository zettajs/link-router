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

var path = require('path');

module.exports = function(request) {
  var xfp = request.headers['x-forwarded-proto'];
  var xfh = request.headers['x-forwarded-host'];
  var protocol;

  if (xfp && xfp.length) {
    protocol = xfp.replace(/\s*/, '').split(',')[0];
  } else {
    protocol = request.connection.encrypted ? 'https' : 'http';
  }

  var host = xfh || request.headers['host'];

  if (!host) {
    var address = request.connection.address();
    host = address.address;
    if (address.port) {
      if (!(protocol === 'https' && address.port === 443) && 
          !(protocol === 'http' && address.port === 80)) {
        host += ':' + address.port
      }
    }
  }

  return protocol + '://' + path.join(host, request.url);
};
