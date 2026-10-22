const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { validateServerPools } = require('./service-policy');

class ConfigManager extends EventEmitter {
  constructor(fileName) {
    super();
    this.config = null;  // No routing is ready until a complete candidate validates.
    this.configPath = path.join(__dirname, "..", "config", fileName);
    this.watchDebounceTimer = null;
    this.loadConfig();
    this.watchConfig();
  }

  loadConfig() {
    try {
      const data = fs.readFileSync(this.configPath, 'utf8');
      const newConfig = validateServerPools(JSON.parse(data));
      
      // Check whether the configuration changed
      if (JSON.stringify(this.config) !== JSON.stringify(newConfig)) {
        console.log('Configuration updated');
        this.config = newConfig;
        // Emit the configuration update event
        this.emit('configChanged', this.config);
      }
      return true;
    } catch {
      if (!this.isReady()) {
        console.error('Gateway configuration unavailable; service is unready');
        throw new Error('GATEWAY_CONFIG_UNREADY');
      }
      console.error('Configuration reload rejected; keeping last valid configuration');
      return false;
    }
  }

  watchConfig() {
    fs.watch(path.dirname(this.configPath), (eventType, filename) => {
      if (filename === path.basename(this.configPath) && ['change', 'rename'].includes(eventType)) {
        // Clear the previous timer
        if (this.watchDebounceTimer) {
          clearTimeout(this.watchDebounceTimer);
        }
        // Set a new timer to run after 300ms
        this.watchDebounceTimer = setTimeout(() => {
          this.loadConfig();
        }, 300);
      }
    });
  }

  isReady() {
    return this.config !== null;
  }

  // Get the configuration
  getConfig() {
    return this.config;
  }

  // Get a specific configuration value
  get(key) {
    return this.config[key];
  }
}

module.exports = {
    ConfigManager
};
