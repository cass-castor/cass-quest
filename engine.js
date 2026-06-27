
class Parser {
    constructor(vocabulary = {}) {
        this.noiseWords = new Set(["the", "a", "an", "of", "at", "to", "from", "some", "with"]);
        this.vocabulary = vocabulary; // Maps canonical action -> [aliases]
    }

    parse(text) {
        text = text.toLowerCase().trim();
        if (!text) return { action: null, target: null };

        const tokens = text.split(/\s+/);
        const filtered = tokens.filter(t => !this.noiseWords.has(t));

        if (filtered.length === 0) return { action: null, target: null };

        const rawVerb = filtered[0];
        const target = filtered.slice(1).join(" ");

        let canonicalAction = null;
        for (const [action, aliases] of Object.entries(this.vocabulary)) {
            if (rawVerb === action || aliases.includes(rawVerb)) {
                canonicalAction = action;
                break;
            }
        }

        if (!canonicalAction) {
            canonicalAction = rawVerb;
        }

        return { action: canonicalAction, target: target || null };
    }
}

class Item {
    constructor({ id, name, description, properties = {}, interactions = {}, contents = [] }) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.properties = properties;
        this.interactions = interactions;
        this.contents = contents;
    }
}

class Room {
    constructor({ id, name, description, exits = {}, items = [] }) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.exits = exits;
        this.items = items;
    }
}

class World {
    constructor(scenarioData) {
        this.scenarioData = scenarioData;
        this.startRoomId = scenarioData.start_room;
        this.playerRoomId = this.startRoomId;
        this.playerInventory = [];
        this.state = scenarioData.initial_state || {};
        this.vocabulary = scenarioData.vocabulary || {};
        this.templates = scenarioData.templates || {
            "room": "[{name}]\n{description}",
            "item_not_found": "I don't see a {target} here.",
            "cant_do": "I can't {verb} the {item}.",
            "move_success": "You move to {target}.",
            "move_fail": "The way is blocked or locked."
        };

        this.parser = new Parser(this.vocabulary);
        this.rooms = {};
        this.items = {};

        // Initialize items first
        for (const [iid, idata] of Object.entries(scenarioData.items)) {
            this.items[iid] = new Item(idata);
        }

        // Initialize rooms
        for (const [rid, rdata] of Object.entries(scenarioData.rooms)) {
            this.rooms[rid] = new Room(rdata);
        }
    }

    getRoom() {
        return this.rooms[this.playerRoomId];
    }

    getRoomDescription() {
        const room = this.getRoom();
        if (room.dynamic_descriptions) {
            for (const [stateKey, valueMap] of Object.entries(room.dynamic_descriptions)) {
                const currentVal = this.state[stateKey];
                if (valueMap[currentVal] !== undefined) {
                    return valueMap[currentVal];
                }
            }
        }
        return room.description;
    }

    getItem(targetName) {
        const room = this.getRoom();
        const matches = (item, target) => {
            if (!target) return false;
            const tLow = target.toLowerCase();
            return (item.name && item.name.toLowerCase() === tLow) || 
                   (item.id && item.id.toLowerCase() === tLow);
        };

        // 1. Room items
        for (const iid of room.items) {
            const item = this.items[iid];
            if (matches(item, targetName)) return item;
        }
        // 2. Inventory items
        for (const iid of this.playerInventory) {
            const item = this.items[iid];
            if (matches(item, targetName)) return item;
        }
        // 3. Open containers in room
        for (const iid of room.items) {
            const container = this.items[iid];
            if (container.properties.openable && container.properties.is_open) {
                for (const cid of container.contents) {
                    const item = this.items[cid];
                    if (matches(item, targetName)) return item;
                }
            }
        }
        // 4. Open containers in inventory
        for (const iid of this.playerInventory) {
            const container = this.items[iid];
            if (container.properties.openable && container.properties.is_open) {
                for (const cid of container.contents) {
                    const item = this.items[cid];
                    if (matches(item, targetName)) return item;
                }
            }
        }
        return null;
    }

    move(target) {
        const room = this.getRoom();
        if (target in room.exits) {
            const exitData = room.exits[target];
            if (typeof exitData === 'object') {
                const condition = exitData.condition;
                if (condition) {
                    const [key, val] = condition;
                    if (this.state[key] !== val) {
                        return "LOCKED_EXIT";
                    }
                }
                this.playerRoomId = exitData.dest;
            } else {
                this.playerRoomId = exitData;
            }
            return true;
        }
        return false;
    }

    handleInteraction(action, target) {
        if (action === "list" || action === "ls") {
            const room = this.getRoom();
            const items = room.items.map(id => this.items[id].name);
            return items.length > 0 ? items.join("  ") : "Directory is empty.";
        }

        if (action === "move") {
            const result = this.move(target);
            if (result === true) return this.templates.move_success.replace("{target}", target);
            if (result === "LOCKED_EXIT") return this.templates.move_fail;
            return this.templates.move_fail.replace("{target}", target);
        }

        const item = this.getItem(target);
        if (!item) {
            return this.templates.item_not_found.replace("{target}", target || "nothing");
        }

        if (action in item.interactions) {
            const interaction = item.interactions[action];
            if (typeof interaction === 'object') {
                if (interaction.condition) {
                    const [key, val] = interaction.condition;
                    if (this.state[key] !== val) {
                        return interaction.fail_response || "You can't do that right now.";
                    }
                }
                if (interaction.effect) {
                    for (const [k, v] of Object.entries(interaction.effect)) {
                        this.state[k] = v;
                    }
                }
                return interaction.response || "Action performed.";
            } else {
                if (interaction === "ACTION_TAKE") return this._doTake(item);
                if (interaction === "ACTION_OPEN") return this._doOpen(item);
                return interaction;
            }
        }

        if (action === "take" && (item.properties.portable !== false)) {
            return this._doTake(item);
        }
        if (action === "open" && item.properties.openable) {
            return this._doOpen(item);
        }

        return this.templates.cant_do.replace("{verb}", action).replace("{item}", item.name);
    }

    _doTake(item) {
        const room = this.getRoom();
        let containerId = null;
        for (const iid of room.items) {
            const container = this.items[iid];
            if (container.contents && item.id in container.contents) { // wait, item.id is a string
                // The original python used item.id in container.contents
            }
        }
        // Refined container check for JS
        const findContainer = (list) => {
            for (const iid of list) {
                const container = this.items[iid];
                if (container.contents && container.contents.includes(item.id)) return iid;
            }
            return null;
        };

        containerId = findContainer(room.items) || findContainer(this.playerInventory);

        if (containerId) {
            const container = this.items[containerId];
            if (!container.properties.is_open) {
                return this.templates.container_closed?.replace("{name}", container.name) || `The ${container.name} is closed.`;
            }
            container.contents = container.contents.filter(id => id !== item.id);
            this.playerInventory.push(item.id);
            return this.templates.take_success?.replace("{item}", item.name).replace("{container}", container.name) || `Taken from ${container.name}.`;
        }

        if (room.items.includes(item.id)) {
            room.items = room.items.filter(id => id !== item.id);
            this.playerInventory.push(item.id);
            return this.templates.take_success?.replace("{item}", item.name) || "Taken.";
        }

        return this.templates.already_have?.replace("{item}", item.name) || `You already have ${item.name}.`;
    }

    _doOpen(item) {
        if (item.properties.is_open) {
            return this.templates.already_open?.replace("{item}", item.name) || `The ${item.name} is already open.`;
        }
        item.properties.is_open = true;
        let contentsMsg = "";
        if (item.contents && item.contents.length > 0) {
            const names = item.contents.map(id => this.items[id].name).join(", ");
            contentsMsg = ` ${this.templates.inside_view?.replace("{item}", item.name) || "Inside you see:"} ${names}`;
        }
        return (this.templates.open_success?.replace("{item}", item.name) || `You open the ${item.name}.`) + contentsMsg;
    }
}
