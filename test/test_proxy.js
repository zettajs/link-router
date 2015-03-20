var assert = require('assert');
var request = require('supertest');
var Proxy = require('../proxy');
var MockEtcd = require('./mocks/mock_etcd');
var VersionClient = require('../version_client');
var ServiceRegistryClient = require('../service_registry_client');
var RouterClient = require('../router_client');

function getBody(fn) {
  return function(res) {
    try {
      if(res.text) {
        var body = JSON.parse(res.text);
      } else {
        var body = '';
      }
    } catch(err) {
      throw new Error('Failed to parse JSON body'); 
    }
    
    fn(res, body);  
  }  
}

describe('Proxy', function() {
  var proxy = null;

  beforeEach(function(done) {
    var etcd = new MockEtcd();
    etcd.keyValuePairs['/zetta/version'] = { value: '{"version":"1"}' };
    etcd.keyValuePairs['/services/zetta'] = [];
    etcd.keyValuePairs['/router/zetta'] = [];
    var versionClient = new VersionClient({ client: etcd });
    var serviceRegistryClient = new ServiceRegistryClient({ client: etcd });
    var routerClient = new RouterClient({ client: etcd });
    proxy = new Proxy(serviceRegistryClient, routerClient, versionClient);
    proxy.listen(0);
    done();
  });

  afterEach(function(done) {
    proxy._server.close();  
    done();
  });

  describe('request routing', function() {
    it('will properly route to the root request', function(done) {
      request(proxy._server)
        .get('/')
        .expect('Access-Control-Allow-Origin', '*', done);
    });

    it('will have a list of links.', function(done) {
       request(proxy._server)
        .get('/')
        .expect(getBody(function(res, body) {
          assert.ok(Array.isArray(body.links));  
        }))
        .end(done);
    });

    it('will have a class of root', function(done) {
      request(proxy._server)
        .get('/')
        .expect(getBody(function(res, body) {
          assert.equal(body.class[0], 'root');  
        }))
        .end(done);  
    });

    it('will only have a self link', function(done) {
      request(proxy._server)
        .get('/')
        .expect(getBody(function(res, body) {
          var selfLink = body.links[0];
          assert.equal(body.links.length, 1);
          assert.notEqual(selfLink.rel.indexOf('self'), -1);
        }))
        .end(done);  
    });
  });  
});
