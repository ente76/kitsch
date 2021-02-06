// Kitsch: a collection of cheap, popular, and marketable improvements to Gnome
// Copyright (C) 2021 Christian Klaue (mail@ck76.de)

'use strict';

const UI = imports.ui;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Settings = imports.misc.extensionUtils.getSettings();

const DEBUG = 0;
const INFO = 1;
const WARNING = 2;
const ERROR = 3;
var LogLevel = DEBUG;

/******************************************************************************/
/***** LOGGING                                                            *****/
/******************************************************************************/

function debug(message) {
    if (LogLevel <= DEBUG) {
        log("[kitsch debug] " + message);
    }
}

function info(message) {
    if (LogLevel <= INFO) {
        log("[kitsch info] " + message);
    }
}

function warning(message) {
    if (LogLevel <= WARNING) {
        log("[kitsch WARNING] " + message);
    }
}

function error(message) {
    if (LogLevel <= ERROR) {
        log("[kitsch ERROR] " + message);
    }
}

function errorDetails(message, error) {
    if (LogLevel <= ERROR) {
        if (error instanceof GLib.Error)
            log("[kitsch ERROR]" + message + "\n" + "GLib.Error(" + error.code + ") " + error.message)
        if (error instanceof Error)
            log("[kitsch ERROR] " + message + "\n" + error.toString() + "\n" + error.stack)
    }
}

function notify(message, details) {
    UI.main.notify(message, details || "");
}

/******************************************************************************/
/***** Kitsch                                                             *****/
/******************************************************************************/

const configChecks = [
    { name: "notifyOnError", type: "boolean", default: true },
    { name: "loglevel", type: "string", default: "warning", values: ["debug", "info", "warning", "error"] },
    {
        name: "hideFromPanel", type: "object", checks: [
            { name: "*", type: "boolean" }
        ]
    },
    {
        name: "wallpaper", type: "object", checks: [
            { name: "interval", type: "number", default: 30 },
            { name: "recursive", type: "boolean", default: true },
            { name: "shuffle", type: "boolean", default: true },
            { name: "paths", type: "object" },
            { name: "mimetypes", type: "object", default: ["image/jpeg", "image/png"] }
        ],
    }
];

class Kitsch {
    constructor(meta) {
        debug("Initializing " + Me.metadata.name + " version " + Me.metadata.version);
    }

    enable() {
        debug("Enabling " + Me.metadata.name + " version " + Me.metadata.version);
        this.start();
    }

    disable() {
        debug("Disabling " + Me.metadata.name);
        this.stop();
    }

    start() {
        try {
            // determine config location
            let configFilename = Settings.get_string("config");
            configFilename = configFilename || GLib.get_home_dir() + "/.config/kitsch.json";
            debug("Config location: " + configFilename);

            // TODO: async
            // check if custom config exists; restore default config file otherwise
            this.configFile = Gio.File.new_for_path(configFilename);
            if (!this.configFile.query_exists(null)) {
                let defaultConfig = Gio.File.new_for_path(Me.path + "/default.json");
                defaultConfig.copy(this.configFile, 0, null, null);
                info("Config not found @ location: " + configFilename + ". Default config restored.");
            }

            // setup monitor for config file
            this.configMonitor = this.configFile.monitor(Gio.FileMonitorFlags.NONE, null);
            this.configMonitor.connect("changed", this.restart.bind(this));

            // TODO: async
            // load config file
            let [ok, content] = GLib.file_get_contents(configFilename);
            if (ok) {
                let contentString = imports.byteArray.toString(content);
                this.config = parseConfig(JSON.parse(contentString), configChecks, "");
            } else throw new Error("Could not load config file.");
        } catch (error) {
            errorDetails("Loading config failed due to an error.", error);
            notify("Loading config failed due to an error.", error);
            return;
        }

        this.elements = {};
        if (this.config.hideFromPanel) {
            for (const element in this.config.hideFromPanel) {
                this.hideFromPanel(element);
                this.elements[element] = UI.main.panel.statusArea[element].connect("show", this.hideFromPanel.bind(this, element));
            }
        }
        this.wallpapers = [];
        for (const index in this.config.wallpaper.paths) {
            let path = this.config.wallpaper.paths[index];
            debug(path);
            if (path.startsWith("~")) path = GLib.get_home_dir() + path.substring(1);
            let fd = Gio.File.new_for_path(path);
            this.loadFD(fd, true);
        }
        debug(this.wallpapers);
        this.wallpaper = new Gio.Settings({ 'schema': 'org.gnome.desktop.background' });
        this.counter = Settings.get_int("lastwp");
        debug(this.counter);
        this.setWallpaper();
    }

    setWallpaper() {
        if (this.config.wallpaper.shuffle) {
            let r = Math.trunc(Math.random() * (this.wallpapers.length - 1));
            if (r >= this.counter) this.counter = r + 1
            else this.counter = r
        } else {
            this.counter += 1;
            if (this.counter >= this.wallpapers.length) this.counter = 0;
        }
        Settings.set_int("lastwp", this.counter);
        this.wallpaper.set_string('picture-uri', this.wallpapers[this.counter]);
        this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.config.wallpaper.interval * 1000, this.setWallpaper.bind(this));
    }

    hideFromPanel(item) {
        UI.main.panel.statusArea[item].hide();
    }

    showOnPanel(item) {
        UI.main.panel.statusArea[item].show();
    }

    stop() {
        if (this.timer) {
            GLib.source_remove(this.timer);
            this.timer = null;
        }
        for (const element in this.elements) {
            UI.main.panel.statusArea[element].disconnect(this.elements[element]);
            this.showOnPanel(element);
        }
        if (this.configMonitor) {
            this.configMonitor.cancel();
            this.configMonitor = null;
        }
    }

    restart() {
        info("Change of config detected: restarting " + Me.metadata.name);
        this.stop();
        this.start();
    }

    loadFD(fd, recursive) {
        let info = fd.query_info("standard::*", Gio.FileQueryInfoFlags.None, null);
        if ((info.get_file_type() === Gio.FileType.DIRECTORY)) {
            let childs = fd.enumerate_children("standard::*", Gio.FileQueryInfoFlags.None, null);
            let child;
            while ((child = childs.next_file(null)) !== null)
                if ((child.get_file_type() === Gio.FileType.DIRECTORY) && recursive) this.loadFD(fd.resolve_relative_path(child.get_name()), this.config.wallpaper.recursive);
                else if (child.get_file_type() === Gio.FileType.UNKNOWN) error("location " + child.get_path() + " cannot be accessed.");
                else if (this.config.wallpaper.mimetypes.includes(child.get_content_type())) this.wallpapers.push(fd.resolve_relative_path(child.get_name()).get_path());
                else error("location " + child.get_name() + " was ignored");
        } else if (info.get_file_type() === Gio.FileType.UNKNOWN) error("location " + info.get_path() + " cannot be accessed.");
        else if (this.config.wallpaper.mimetypes.includes(info.get_content_type())) this.wallpapers.push(fd.get_path());
        else error("location " + fd.get_path() + " is something unexpected: " + type);
    }

}

function parseConfig(source, checks, domain) {
    let target = {};
    for (const property in checks) {
        if (checks[property].name === "*") {
            // special: any source of a specific type will be taken, i.e. don't loop the checks, now loop the source
            // there may only be one such check
            for (const item in source) {
                if (typeof source[item] !== checks[property].type) error("config " + domain + item + ": " + source[item] + " - invalid value, ignoring the parameter");
                else {
                    if (typeof source[item] === "object")
                        if ("checks" in checks[property]) target[item] = parseConfig(source[item], checks[property].checks, domain + item + ".");
                        else {
                            target[item] = source[item];
                            debug("config " + domain + item + ": " + target[item]);
                        }
                    else {
                        target[item] = source[item];
                        debug("config " + domain + item + ": " + target[item]);
                    }
                }
            }
        } else if (checks[property].name in source) {
            // property is defined
            if (typeof source[checks[property].name] !== checks[property].type) {
                // property is defined with wrong type
                if ("default" in checks[property]) {
                    // property is defined using wrong type --> default value is used
                    error("config " + domain + checks[property].name + ": " + source[checks[property].name] + " - invalid value, using default value: " + checks[property].default);
                    target[checks[property].name] = checks[property].default;
                } else
                    // property was defined using wrong type --> default value does not exist --> no value used
                    error("config " + domain + checks[property].name + ": " + source[checks[property].name] + " - invalid value, ignoring the value");
            } else
                // property is defined with correct type
                if (typeof source[checks[property].name] === "object") {
                    if ("checks" in checks[property]) target[checks[property].name] = parseConfig(source[checks[property].name], checks[property].checks, domain + checks[property].name + ".");
                    else {
                        target[checks[property].name] = source[checks[property].name];
                        debug("config " + domain + checks[property].name + ": " + target[checks[property].name]);
                    }
                } else if ("values" in checks[property]) {
                    // property is defined with correct type & checks contain a list of valid values
                    if (!checks[property].values.includes(source[checks[property].name].toLowerCase())) {
                        // property is defined with correct type & checks contain a list of valid values --> property does not match any of that list --> default value is used
                        error("config " + domain + checks[property].name + ": " + source[checks[property].name] + " - invalid value, using default value: " + checks[property].default);
                        target[checks[property].name] = checks[property].default;
                    } else {
                        // property is defined with correct type & checks contain a list of valid values --> property does match one of that list
                        target[checks[property].name] = source[checks[property].name].toLowerCase();
                        debug("config " + domain + checks[property].name + ": " + target[checks[property].name]);
                    }
                } else {
                    // property is defined with correct type & checks contain a list of valid values --> property does match one of that list
                    target[checks[property].name] = source[checks[property].name];
                    debug("config " + domain + checks[property].name + ": " + target[checks[property].name]);
                }
        } else if ("default" in checks[property]) {
            // property is not defined --> use default
            debug("no value for property " + domain + checks[property].name + ", using default value: " + checks[property].default);
            target[checks[property].name] = checks[property].default;
        }
    }
    return target;
}

/******************************************************************************/
/***** INIT                                                               *****/
/******************************************************************************/

function init(meta) {
    return new Kitsch(meta);
}