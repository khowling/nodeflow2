/**
 * Created by keith on 10/10/14.
 */

module.exports = function(RED) {
    "use strict";

    var https = require("https"),
        OAuth = require('oauth'),
        url = require('url'),
        Faye = require('faye');


    function SalesforceNode(n) {
        RED.nodes.createNode(this, n);
        this.screen_name = n.screen_name;
    }

    RED.nodes.registerType("salesforce-credentials", SalesforceNode, {
        credentials: {
            screen_name: {type: "text"},
            access_token: {type: "password"},
            access_token_secret: {type: "password"}
        }});

    /* Run when the node is deplyed */
    function SalesforceGetNode(n) {
        RED.nodes.createNode(this, n);

        this.input_type = n.input_type;
        this.sobject = n.sobject;
        this.sobject_fields = n.sobject_fields;
        this.soql = n.soql;
        this.salesforce = n.salesforce;
        this.interval = n.interval;
        this.push_topic = n.push_topic;

        this.log('calling SalesforceGetNode() : ' + this.input_type + ' : ' + this.sobject + ' : ' + this.interval);

        this.salesforceConfig = RED.nodes.getNode(this.salesforce); // the 'salesforce-credentials' node

        var credentials = RED.nodes.getCredentials(this.salesforce);
        this.log('credentials:' + JSON.stringify(credentials) + ', "salesforce-credentials".screen_name: ' + this.salesforceConfig.screen_name);

        if (credentials && credentials.screen_name == this.salesforceConfig.screen_name) {
            var node = this;
            node.poll_ids = [];
            node.deactivate = function () {
                node.log('deactivate salesforce-in');
                node.active = false;

                if (node._fayeClient) {
                    node.log('Unsubscribing from ' + node.push_topic);
                    node._fayeClient.unsubscribe("/topic/" + node.push_topic)
                }

                if (node.poll_ids) {
                    for (var i = 0; i < node.poll_ids.length; i++) {
                        clearInterval(node.poll_ids[i]);
                    }
                }
            }

            node.activate = function () {
                node.log('activating salesforce-in');
                node.active = true;

                /* complete logic to run the Node */
                var runNode = function () {

                    /* complete logic to support 'SOQL' or 'SOBJECT' modes */
                    var runextract = function () {

                        var query = '';
                        if (node.input_type == 'soql') {
                            query = node.soql;
                        } else if (node.input_type == 'sobjects') {
                            query = 'SELECT ' + node.sobject_fields + ' FROM ' + node.sobject;
                        }

                        var getopts = {
                            hostname: url.parse(credentials.instance_url).hostname,
                            path: '/services/data/v29.0/query/?q=' + encodeURIComponent(query),
                            headers: {
                                'Authorization': 'Bearer ' + credentials.access_token
                            }};

                        var getres = ''
                        https.get(getopts, function (res_data) {
                            res_data.setEncoding('utf8');
                            res_data.on('data', function (chunk) {
                                getres += chunk;
                            });
                            res_data.on('end', function () {
                                if (res_data.statusCode == 401) {

                                    node.warn('Unauthorized, do a refresh cycle');
                                    oAuthRefresh(node.salesforce, function () {
                                        runextract();
                                    }, function (msg) {
                                        node.deactivate();
                                        node.error(msg);

                                    })

                                } else if (res_data.statusCode == 200) {
                                    var msg = {
                                        topic: node.input_type + "/" + credentials.screen_name,
                                        payload: JSON.parse(getres).records,
                                        other: "other" };

                                    node.send(msg);
                                } else {
                                    node.deactivate();
                                    node.error("yeah something broke." + res_data.statusCode);
                                }
                            });
                        }).on('error', function (e) {
                            node.deactivate();
                            node.error("Got REST API error: " + e.message);
                        });
                    };


                    if (node.input_type == 'soql' || node.input_type == 'sobjects') {
                        runextract();
                    } else if (node.input_type == 'StreamingAPI') {

                        node.log('Proactive oauth refresh');
                        oAuthRefresh(node.salesforce, function () {

                            /* source : https://github.com/faye/faye/blob/master/javascript/protocol/client.js */
                            if (!node._fayeClient) {
                                Faye.Transport.NodeHttp.prototype.batching = false; // prevent streaming API server error
                                Faye.Logging.LOG_LEVELS = 0;
                                node._fayeClient = new Faye.Client(credentials.instance_url + '/cometd/29.0', {});
                                node._fayeClient.setHeader('Authorization', 'Bearer ' + credentials.access_token);
                            }
                            node.log('subscript Faye Client : ' + "/topic/" + node.push_topic);

                            node._streamListener = function (message) {
                                node.log(node.input_type + ': Got message : ' + JSON.stringify(message));
                                var msg = {
                                    topic: node.input_type + "/" + credentials.screen_name,
                                    payload: message.sobject,
                                    other: "other" };

                                node.send(msg);
                            };

                            node._fayeClient.subscribe("/topic/" + node.push_topic, node._streamListener);

                        }, function (msg) {
                            node.deactivate();
                            node.error(msg);

                        })

                    } else {
                        node.deactivate();
                        node.error("input_type not yet implemented: " + node.input_type);
                    }

                };


                /* run the node for the 1st time */
                runNode();

                /* setup Polling Interval */
                if (node.interval > 0 && node.input_type != 'StreamingAPI') {
                    node.poll_ids.push(setInterval(runNode, (node.interval * 1000)));
                }
            }
            if (n.active) node.activate();

        } else {
            this.error("missing salesforce credentials");
        }

        this.on('close', function () {
            if (this.poll_ids) {
                for (var i = 0; i < this.poll_ids.length; i++) {
                    clearInterval(this.poll_ids[i]);
                }
            }
        });
    }

    RED.nodes.registerType("salesforce in", SalesforceGetNode);


    function SalesforcePutNode(n) {
        var node = this;
        RED.nodes.createNode(node, n);


        node.salesforce = n.salesforce;
        node.output_type = n.output_type;
        node.output_sobject = n.output_sobject;
        node.upsert_field = n.upsert_field;

        node.log('calling SalesforcePutNode() : ' + node.output_sobject);

        node.salesforceConfig = RED.nodes.getNode(node.salesforce); // the 'salesforce-credentials' node

        var credentials = RED.nodes.getCredentials(node.salesforce);
        node.log('credentials:' + JSON.stringify(credentials) + ', "salesforce-credentials".screen_name: ' + node.salesforceConfig.screen_name);

        if (credentials && credentials.screen_name == node.salesforceConfig.screen_name) {

            node.log('Setting up on-input for :' + credentials.screen_name);
            node.on("input", function (msg) {
                node.log('got msg : ' + JSON.stringify(msg));

                /* run upload, allowing for oauth refresh & logic retry */
                var runupload = function (postopts, sendobj, callback) {

                    var getres = ''
                    var req_data = https.request(postopts, function (res_data) {

                        res_data.on('data', function (chunk) {
                            getres += chunk;
                        });
                        res_data.on('end', function () {
                            if (res_data.statusCode == 401) {

                                node.warn('Unauthorized, do a refresh cycle');
                                oAuthRefresh(node.salesforce, function () {
                                    /* re-get the new credentials & re-run */
                                    credentials = RED.nodes.getCredentials(node.salesforce);
                                    runupload(postopts, sendobj, callback);
                                }, function (msg) {
                                    callback('oAuthRefresh error : ' + msg);
                                })

                            } else if (res_data.statusCode == 201 || res_data.statusCode == 204) {
                                /* 201 - “Created” success code, for POST request. */
                                /* 204 - Upsert Updated an existing record */
                                node.log('success ' + res_data.statusCode + ' : ' + getres);
                                if (getres) {
                                    var msg = {
                                        topic: node.output_type + "/" + credentials.screen_name,
                                        payload: JSON.parse(getres)
                                    };

                                    node.send(msg);
                                }
                                callback();
                            } else {
                                callback("Something broke : " + res_data.statusCode + ' : ' + getres);
                            }
                        });
                    }).on('error', function (e) {
                        callback("Got REST API error: " + e.message);
                    });
                    req_data.write(JSON.stringify(sendobj));
                    req_data.end();
                }

                /** If array of records, ensure we process one at a time **/
                var asyncloop = function (i) {
                    if (i < msg.payload.length) {
                        var sendobj = msg.payload[i];
                        console.log('got sendobj : ' + JSON.stringify(sendobj));
                        var postopts = {
                            hostname: url.parse(credentials.instance_url).hostname,
                            path: '/services/data/v29.0/sobjects/' + node.output_sobject + '/',
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': 'Bearer ' + credentials.access_token
                            }};

                        if (node.output_type == 'upsert') {
                            postopts.path = postopts.path + node.upsert_field + '/' + sendobj[node.upsert_field];
                            postopts.method = 'PATCH';
                            delete sendobj[node.upsert_field];
                        }

                        node.log('Sending Post ' + JSON.stringify(postopts) + ' DATA : ' + JSON.stringify(sendobj));

                        runupload(postopts, sendobj, function (e) {
                            if (e) {
                                node.error(e);
                            } else {
                                asyncloop(i + 1);
                            }
                        });
                    }
                }

                if (Array.isArray(msg.payload)) {
                    asyncloop(0);
                } else {
                    msg.payload = [msg.payload];
                    asyncloop(0);
                }

            });
        }
    }

    RED.nodes.registerType("salesforce out", SalesforcePutNode);


    /* Oauth2 Authentication */

    var OAuth2 = OAuth.OAuth2;
    var clientId = '3MVG99qusVZJwhskfsiYZz9vAnyT9mA31FwyiITcHnJM89jB3BfoAZYk.Fm1w4V3.8TQJPYFS54RaR8TrwzXF';
    var redirectUrl = 'http://localhost:8000/salesforce/auth/callback';
    var oa = new OAuth2(
        clientId,
        '6940772052013320709',
        'https://login.salesforce.com/',
        'services/oauth2/authorize',
        'services/oauth2/token',
        null);


    var credentials = {};
    var oAuthRefresh = function (nodeid, successcallback, errorcallback) {

        var credentials = RED.nodes.getCredentials(nodeid);
        console.log('oAuthRefresh nodeid ' + nodeid + ', got credentials : ' + JSON.stringify(credentials));
        if (credentials.refresh_token != null) {
            oa.getOAuthAccessToken(
                credentials.refresh_token,
                { grant_type: 'refresh_token', redirect_uri: redirectUrl, format: 'json'},
                function (error, oauth_access_token, oauth_refresh_token, results) {
                    if (error) {
                        errorcallback("Error with Oauth refresh cycle " + JSON.stringify(error));
                    } else {
                        console.log('oAuthRefresh success addCredentials for ' + nodeid + ', got token : ' + oauth_access_token);
                        credentials.access_token = oauth_access_token;
                        //    RED.nodes.deleteCredentials(nodeid);
                        RED.nodes.addCredentials(nodeid, credentials);
                        successcallback();
                    }
                });
        } else {
            errorcallback("No refresh Token, ensure your connected app is setup to allow refresh scope & only login on first use");

        }
    }

    /* Called by 'pollSalesforceCredentials', see if Oauth call back has stored the credentials yet */
    RED.httpAdmin.get('/salesforce/:id', function (req, res) {
        var credentials = RED.nodes.getCredentials(req.params.id);
        if (credentials) {
            res.send(JSON.stringify({sn: credentials.screen_name}));
        } else {
            res.send(JSON.stringify({}));
        }
    });

    RED.httpAdmin.delete('/salesforce/:id', function (req, res) {
        RED.nodes.deleteCredentials(req.params.id);
        res.send(200);
    });

    RED.httpAdmin.get('/salesforce/:id/sobjects/:mode', function (req, res) {
        var nodeid = req.params.id,
            mode = 'sobjects' + ((req.params.mode == 'all') ? '' : ('/' + req.params.mode + '/describe'));

        if (req.params.mode == 'StreamingAPI') {
            mode = 'query/?q=' + encodeURIComponent('select Id, Name, Query, ApiVersion, IsActive, NotifyForFields, NotifyForOperations from PushTopic');
        }
        console.log('Get salesforce MetaData for Node ' + nodeid + ', mode : ' + mode);

        var getMetaSObjectDate = function () {
            var credentials = RED.nodes.getCredentials(nodeid);

            /* get the username */
            var getres = '', getopts = {
                hostname: url.parse(credentials.instance_url).hostname,
                path: '/services/data/v29.0/' + mode,
                headers: {
                    'Authorization': 'Bearer ' + credentials.access_token
                }};

            https.get(getopts, function (res_ident) {
                res_ident.setEncoding('utf8');
                res_ident.on('data', function (chunk) {
                    getres += chunk;
                });
                res_ident.on('end', function () {
                    console.log('MetaData results ' + res_ident.statusCode + ', got:' + getres);
                    if (res_ident.statusCode == 401) {
                        console.log('Unauthorized, do a refresh cycle');
                        oAuthRefresh(nodeid, function () {
                            getMetaSObjectDate();
                        }, function (msg) {
                            res.send({ sobjects: [
                                {name: 'ERROR', label: msg}
                            ]});
                        });
                    }
                    else if (res_ident.statusCode == 200) {

                        res.send(getres);
                    } else {
                        res.send({ sobjects: [
                            {name: 'ERROR', label: res_ident.statusCode}
                        ]});
                    }
                });
            }).on('error', function (e) {
                console.log("Got error: " + e.message);
                res.send("yeah something broke.");
            });
        };
        getMetaSObjectDate();
    });

    RED.httpAdmin.post("/salesforce/:id/activate/:state", function (req, res) {
        var node = RED.nodes.getNode(req.params.id);
        var state = req.params.state;
        if (node != null) {
            if (state === "enable") {
                node.activate();
                res.send(200);
            } else if (state === "disable") {
                node.deactivate();
                res.send(201);
            } else {
                res.send(404);
            }
        } else {
            res.send(404);
        }
    });

    /* Initiate the Oauth handshake for the "salesforce-credentials" id */
    RED.httpAdmin.get('/salesforce/:id/auth', function (req, res) {
        res.redirect(oa.getAuthorizeUrl({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: redirectUrl,
            display: 'page',
            state: req.params.id}));
    });

    /* salesforce calls the callback with the passed in "salesforce-credentials" id in the 'state' parameter */
    RED.httpAdmin.get('/salesforce/auth/callback', function (req, res, next) {
        var nodeid_state = req.param('state'),
            code = req.param('code');

        console.log('/salesforce/auth/callback : state : ' + nodeid_state);


        oa.getOAuthAccessToken(
            code,
            { grant_type: 'authorization_code', redirect_uri: redirectUrl, format: 'json'},
            function (error, oauth_access_token, oauth_refresh_token, results) {
                if (error) {
                    console.log("Got error: " + error);
                    res.send("yeah something broke.");
                } else {
                    console.log('/salesforce/auth/callback : request authorisation_code, got at: ' + oauth_access_token + ', rt: ' + oauth_refresh_token + ', rest: ' + JSON.stringify(results));

                    var credentials = {};
                    credentials.access_token = oauth_access_token;
                    credentials.refresh_token = oauth_refresh_token;
                    credentials.identity_url = url.parse(results.id);
                    credentials.instance_url = results.instance_url;

                    /* get the username */
                    var getres = '', getopts = {
                        hostname: url.parse(credentials.instance_url).hostname,
                        path: credentials.identity_url.path,
                        headers: {
                            'Authorization': 'Bearer ' + credentials.access_token
                        }};

                    https.get(getopts, function (res_ident) {

                        res_ident.setEncoding('utf8');
                        res_ident.on('data', function (chunk) {
                            getres += chunk;
                        });
                        res_ident.on('end', function () {
                            var obj = JSON.parse(getres);
                            credentials.screen_name = obj.username;
                            console.log("/salesforce/auth/callback :RED.nodes.addCredential: " + nodeid_state + ' : ' + JSON.stringify(credentials));
                            RED.nodes.addCredentials(nodeid_state, credentials);

                            res.send("<html><head></head><body>Authorised - you can close this window and return to Node-RED</body></html>");
                        });
                    }).on('error', function (e) {
                        console.log("Got error: " + e.message);
                        res.send("yeah something broke.");
                    });
                }
            }
        );
    });
}
