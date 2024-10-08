const { Client, GatewayIntentBits, Partials, ActivityType } = require("discord.js");
const wol = require('wake_on_lan');
const EventSource = require('eventsource');
const fs = require('fs');
const yaml = require('yaml');

// parse config file
console.log("Parsing config file...");
let config;
try {
    const file = fs.readFileSync('./config.yaml', 'utf8');
    config = yaml.parse(file);

    // Replace placeholders in the help_message
    if (config.help_message) {
        config.help_message = config.help_message.replace(/\${command_prefix}/g, config.command_prefix);
    }

    console.log("Config file parsed successfully.");
} catch (e) {
    console.error("Error while parsing config file: " + e);
}

const client = new Client({
    'intents': [GatewayIntentBits.GuildMessages, GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    'partials': [Partials.Channel]
});

// sends a ping request to the client. Returns true if successful, false if an error occured
async function ping() {
    try {
        const response = await fetch(`http://${config.client_address}/ping`);
        return response.status == 200;
    } catch (error) {
        return false;
    }
}

// delays async function for a specified time
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// waits until client is online. Returns true if client is online, false if timeout is reached
async function waitUntilOnline(timeout = 60000, interval = 1000) {
    let ms = 0;
    while (ms < timeout) {
        if (await ping()) {
            return true;
        }
        await delay(interval);
        ms += interval;
    }
    return false;
}

client.on("ready", () => {
    console.log("Discord Bot is ready! Logged in as " + client.user.tag);

    // update activity depending on client status
    setInterval(async () => {
        if (await ping()) {
            client.user.setActivity("✅ Client is online", { type: ActivityType.Custom });
        } else {
            client.user.setActivity("❌ Client is offline", { type: ActivityType.Custom });
        }
    }, 1000);
});

// react to messages starting with the command prefix
client.on("messageCreate", async (message) => {
    if (message.author.bot) return; // ignore messages from bots

    if (message.channel.type == 1 && !config.dm_enabled) {
        message.channel.send(":x: Direct Messages are disabled.");
        return;
    }

    if (message.content.startsWith(config.command_prefix)) {
        const args = message.content.slice(config.command_prefix.length).trim().split(/ +/g); // split arguments, command is ar args[0]

        switch (args[0]) {
            case "help": {
                message.channel.send(config.help_message);
                break;
            }

            case "wakeup": {
                // check if client is already online
                if (await ping()) {
                    message.channel.send(":white_check_mark: Client is already online.");
                } else {
                    // send WOL packet to client
                    wol.wake(config.client_mac, function (error) {
                        if (error) {
                            message.channel.send(":x: An error occured while sending the WOL packet.")
                        } else {
                            message.channel.send(":white_check_mark: WOL packet sent successfully.");
                        }
                    })

                    // wait until client is online
                    if (await waitUntilOnline()) {
                        message.channel.send(":white_check_mark: Client is now online.");
                    } else {
                        message.channel.send(":warning: Client is still offline. Maybe, the wakeup request failed?");
                    }
                }
                break;
            }

            case "shutdown": {
                message.channel.send(":clock2: Sending shutdown command to the client...");
                // send shutdown command and wait for response or timeout
                fetch(`http://${config.client_address}/shutdown`)
                    .then(response => response.status)
                    .then(status => {
                        if (status == 200) {
                            message.channel.send(":white_check_mark: Client is shutting down...");
                        } else {
                            message.channel.send(":x: An error occured while sending the shutdown command.");
                        }
                    })
                    .catch(error => message.channel.send(":x: An error occured while sending the shutdown command. Maybe, the client is already offline?"));
                break;
            }

            case "reboot": {
                message.channel.send(":clock2: Sending reboot command to the client...");
                // send reboot command and wait for response or timeout
                fetch(`http://${config.client_address}/reboot`)
                    .then(response => response.status)
                    .then(status => {
                        if (status == 200) {
                            message.channel.send(":white_check_mark: Client is rebooting...");
                        } else {
                            message.channel.send(":x: An error occured while sending the reboot command.");
                        }
                    })
                    .catch(error => message.channel.send(":x: An error occured while sending the reboot command. Maybe, the client is offline?"));

                await delay(5000); // give client some time to go offline...

                // ...and wait until client is online again
                if (await waitUntilOnline()) {
                    message.channel.send(":white_check_mark: Client is back online.");
                } else {
                    message.channel.send(":warning: Client is still offline. Maybe, the reboot failed?");
                }
                break;
            }

            case "ping": {
                message.channel.send(":clock2: Sending ping command to the client...");

                // send ping command and wait for response or timeout
                if (await ping()) {
                    message.channel.send(":white_check_mark: Client is online.");
                } else {
                    message.channel.send(":x: An error occured while sending the ping command. Maybe, the client is offline?")
                }
                break;
            }

            case "scripts": {
                if (args.length > 1) {
                    if (args[1] == "show") {
                        if (args.length < 3) {
                            message.channel.send(":x: Please provide a script name. Use *!scripts* to list all available scripts.");
                            message.channel.send(`:information: Usage: ${config.command_prefix}scripts show *<script>*`);
                            return;
                        } else {
                            // fetch script content from the client
                            fetch(`http://${config.client_address}/scripts/${args[2]}/show`)
                                .then(response => {
                                    // handle errors
                                    if (response.status == 404) {
                                        message.channel.send(":x: Script not found.");
                                        return;
                                    } else if (response.status == 403) {
                                        message.channel.send(":x: Scripts are disabled in the client configuration.");
                                        return;
                                    }
                                    return response.text();
                                })
                                .then(script => {
                                    if (!script) return; // script not found or scripts are disabled

                                    message.channel.send(`:white_check_mark: **Script *${args[2]}*:**\n\`\`\`${script}\`\`\``);
                                })
                                .catch(error => message.channel.send(":x: An error occured while fetching the scripts. Maybe, the client is offline?"));
                        }
                    }
                } else {
                    // fetch all scripts from the client
                    fetch(`http://${config.client_address}/scripts`)
                        .then(response => {
                            if (response.status == 403) {
                                message.channel.send(":x: Scripts are disabled in the client configuration.");
                                return;
                            }
                            return response.json();
                        })
                        .then(scripts => {
                            if (!scripts) return; // scripts are disabled

                            if (scripts.length > 0) {
                                const scriptsList = scripts.map(script => `:small_blue_diamond: ${script}\n`);
                                message.channel.send(`:white_check_mark: **Available Scripts:**\n${scriptsList.join('')}`);
                            } else {
                                message.channel.send(":x: No scripts found on the client.");
                            }
                        })
                        .catch(error => message.channel.send(":x: An error occured while fetching the scripts. Maybe, the client is offline?"));
                }
                break;
            }

            case "run": {
                let buffer = ``;

                // avoid ratelimiting (discord allows 5 messages per 5 seconds)
                function sendBufferedMessages() {
                    if (buffer.length > 0) {
                        // avoid maximum message length (2000 characters)
                        if (buffer.length > 2000) {
                            message.channel.send(buffer.substring(0, 2000));
                            buffer = buffer.substring(2000);
                        } else {
                            message.channel.send(buffer);
                            buffer = ``;
                        }
                    }
                }
                const writeInterval = setInterval(sendBufferedMessages, 1000);

                const scriptName = args[1];
                // check if script name is provided
                if (!scriptName) {
                    message.channel.send(":x: Please provide a script name. Use *!scripts* to list all available scripts.");
                    message.channel.send(`:information: Usage: ${config.command_prefix}run <script>`);
                    return;
                }

                const sse = new EventSource(`http://${config.client_address}/scripts/${scriptName}/run`);
                console.log(`http://${config.client_address}/scripts/${scriptName}`);

                sse.addEventListener('open', () => {
                    console.log('Connection opened')
                });

                sse.addEventListener('start', (event) => {
                    buffer += `:clock2: Running *${scriptName}*...\n`;
                });

                sse.addEventListener('stdout', (event) => {
                    const data = JSON.parse(event.data);
                    if (data.message.trim()) { // add message to buffer, if it's not empty
                        buffer += `:small_blue_diamond: ${data.message.trim()}\n`;
                    }
                });

                sse.addEventListener('stderr', (event) => {
                    const data = JSON.parse(event.data);
                    if (data.message.trim()) { // add message to buffer, if it's not empty
                        buffer += `:small_orange_diamond: ${data.message.trim()}\n`;
                    }
                });

                sse.addEventListener('exit', (event) => {
                    const data = JSON.parse(event.data);
                    buffer += `:white_check_mark: Script *${scriptName}* exited with code ${data.code}`;
                    sse.close();
                    clearInterval(writeInterval);
                    sendBufferedMessages();
                });

                // user defined errors
                sse.addEventListener('err', (event) => {
                    const data = JSON.parse(event.data);
                    if (data.code == 404) {
                        buffer += `:x: Script *${scriptName}* not found.\n`;
                    } else {
                        buffer += `:x: An error occured while running the script. Error Code: ${data.code}\n`;
                        if (data.code == 'EACCES') {
                            buffer += ":information: The script likely doesn't have execute permissions.\n";
                        }
                    }
                    console.log(data)
                    sse.close();
                    clearInterval(writeInterval);
                    sendBufferedMessages();
                });

                // SSE connection errors (e.g. server offline)
                sse.onerror = (error) => {
                    message.channel.send(":x: An error occured while running the script. Maybe, the client is offline?");
                    console.error("Error while running Script:", error.message || error);
                    sse.close();
                    clearInterval(writeInterval);
                    sendBufferedMessages();
                };
            }
        }
    }
});

client.login(config.token);
