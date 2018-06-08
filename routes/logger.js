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

var moment = require('moment');

// Modified from argo-clf
// https://github.com/mdobson/argo-clf/blob/master/index.js
module.exports = function(req, res, duration) {
  var UNKNOWN = '-';
  var ip = req.connection.remoteAddress;
  var date = '[' + moment(Date.now()).format('D/MMM/YYYY:HH:mm:ss ZZ') + ']';
  var method = req.method;
  var url = req.url;
  var requestSummary = '"' + method + ' ' + url + '"';
  var status = res.statusCode;
  var length = 0;

  if (status !== 101) { 
    var contentLength = res.getHeader('Content-Length');
    if (contentLength === '0' || contentLength === undefined) {
      length = 0;
    } else {
      length = contentLength;
    }
  } else {
    length = 'UPGRADED';
  }


  if (!process.env.SILENT) {
    var log = [ ip, UNKNOWN, UNKNOWN, date, requestSummary, status, length ];
    console.log(log.join('\t'));
  }
}
