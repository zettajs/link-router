var TargetState = require('./target-state');

var Defaults = {
  Interval: 30,
  Timeout: 10,
  HealthyTreshold: 2,
  UnhealthyThreshold: 5
};

var MonitorService = module.exports = function(serviceRegistryClient, opts) {
  var self = this;

  if (!opts) {
    opts = {};
  }

  // If disabled don't do anything
  if (opts.disabled === true) {
    return;
  }
  
  if (!serviceRegistryClient) {
    throw new Error('ServiceRegistryClient must be supplied');
  }
  this.serviceRegistryClient = serviceRegistryClient;

  Object.keys(Defaults).forEach(function(k) {
    self[k] = Defaults[k];
    if (opts.hasOwnProperty(k)) {
      self[k] = opts[k];
    }
  });

  this.state = {}; // { <targetUrl>: TargetState }
};

MonitorService.prototype.getherHosts = function(callback) {
  
}; 

MonitorService.Defaults = Defaults;
