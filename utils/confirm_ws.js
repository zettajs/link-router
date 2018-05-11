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

var crypto = require('crypto');

module.exports = function(request, socket) {
  var key = request.headers['sec-websocket-key'];
  var shasum = crypto.createHash('sha1');
  shasum.update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
  var serverKey = shasum.digest('base64');

  var responseLine = 'HTTP/1.1 101 Switching Protocols';
  var headers = ['Upgrade: websocket', 'Connection: Upgrade',
                 'Sec-WebSocket-Accept: ' + serverKey]

  socket.write(responseLine + '\r\n' + headers.join('\r\n') + '\r\n\r\n');
};
