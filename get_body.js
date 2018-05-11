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


module.exports = function(res, callback) {
  if (!res.readable) {
    return callback();
  }

  var body = null;
  var buf = [];
  var len = 0;

  res.on('readable', function() {
    var chunk;

    while ((chunk = res.read()) != null) {
      buf.push(chunk);
      len += chunk.length;
    }

    if (!buf.length) {
      return;
    }

    if (buf.length && Buffer.isBuffer(buf[0])) {
      body = new Buffer(len);
      var i = 0;
      buf.forEach(function(chunk) {
        chunk.copy(body, i, 0, chunk.length);
        i += chunk.length;
      });
    } else if (buf.length) {
      body = buf.join('');
    }
  });

  var error = null;
  res.on('error', function(err) {
    error = err;
  });

  res.on('end', function() {
    body = body;
    callback(error, body);
  });

  if (typeof res.read === 'function') {
    res.read(0);
  }
};
