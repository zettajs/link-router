var assert = require('assert');
var MockEtcd = require('./mocks/mock_etcd');
var ServiceRegistryClient = require('../service_registry_client');
var MonitorService = require('../monitor/service');

describe('Target Monitor', function() {
  var etcd = null;
  var serviceRegistryClient = null;

  beforeEach(function(done) {
    etcd = new MockEtcd();
    etcd.set('/zetta/version', JSON.stringify({ version: '1'}));
    etcd.mkdir('/services/zetta');
    etcd.mkdir('/router/zetta');
    etcd.keyValuePairs['/services/zetta'] = [];
    etcd.keyValuePairs['/router/zetta'] = [];
    serviceRegistryClient = new ServiceRegistryClient({ client: etcd });
    done();
  });

  afterEach(function(done) {
    done();
  });

  describe('Constructor Options', function() {

    it('without options defaults will be used', function() {
      var monitor = new MonitorService(serviceRegistryClient);
      Object.keys(MonitorService.Defaults).forEach(function(k) {
        assert.equal(monitor[k], MonitorService.Defaults[k]);
      });
    });

    it('allow overide of options', function() {
      var monitor = new MonitorService(serviceRegistryClient, { Interval: 55 });
      assert.equal(monitor.Interval, 55);
    });

  });

});
