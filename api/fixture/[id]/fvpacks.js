const handler = require("./fvpack");

// Backward/forward compat: some frontends call /fvpacks (plural)
module.exports = handler;
