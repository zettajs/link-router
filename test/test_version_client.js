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

var assert = require('assert');
var VersionClient = require('../clients/version_client');
var MockEtcd = require('./mocks/mock_etcd');

describe('Version client', function() {
  var client = null;
  
  beforeEach(function(done) {
    client = new VersionClient({ client: new MockEtcd() });
    done();  
  });  
  
  it('#get', function(done) {
    client._client.set(client._etcdDirectory, '{"version":"1"}');
    
    client.get(function(err, version) {
      assert.equal(version.version, '1');
      done();
    });   
  });

  it('emits change event', function(done) {
    client._client.set(client._etcdDirectory, '{"version":"1"}');
    
    client.on('change', function() {
      done();
    });   

    client._client._trigger('/zetta/version', '{"version":"foo"}');
  });
});
