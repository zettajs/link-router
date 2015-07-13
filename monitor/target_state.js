var State = module.exports =  function(HealthyThreshold, UnhealthyThreshold) {
  this.HealthyThreshold = HealthyThreshold || 2;
  this.UnhealthyThreshold = UnhealthyThreshold || 2;

  this.lastCheck = new Date(0);
  this.lastSeen = new Date(0);
  this.count = 0;
  this.status = 'UNDETERMINED';
};

State.prototype.success = function() {
  this.lastCheck = new Date();
  this.lastSeen = this.lastCheck;

  // Was in failed state
  if (this.count < 0) {
    this.count = 0;
  }

  this.count++;
  if (Math.abs(this.count) >= this.HealthyThreshold || this.status === 'UNDETERMINED') {
    this.status = 'UP';
  }
};

State.prototype.fail = function() {
  this.lastCheck = new Date();

  if (this.count > 0) {
    this.count = 0;
  }

  this.count--;
  if (Math.abs(this.count) >= this.UnhealthyThreshold || this.status === 'UNDETERMINED') {
    this.status = 'DOWN';
  }
};
