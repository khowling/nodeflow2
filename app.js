var express = require('express');
var path = require('path');

var RED = require("node-red");
var http = require('https');
var fs = require('fs');
// Create a server

var app = express();
// Add a simple route for static content served from 'public'
app.use("/",express.static("public"));

// Create the settings object - see default settings.js file for other options
var settings = {
    verbose: true,
    httpAdminRoot:"/red",
    httpNodeRoot: "/api",
    httpStatic: path.join(__dirname, 'public'),
    userDir: path.join(__dirname, 'node-config'),
    nodesDir: path.join(__dirname, 'node-config'),
    functionGlobalContext: { }    // enables global context
};

var options = {
	cert: fs.readFileSync('ssl-cert-snakeoil.pem'),
	key: fs.readFileSync('ssl-cert-snakeoil.key')
};

var server = http.createServer(options,app);
RED.init(server,settings);

// Serve the editor UI from /red
app.use(settings.httpAdminRoot,RED.httpAdmin);
// Serve the http nodes UI from /api
app.use(settings.httpNodeRoot,RED.httpNode);



// redirect root to node red UI
app.get('/', function(req, res) {
    res.redirect(settings.httpAdminRoot);
});

module.exports = server;
