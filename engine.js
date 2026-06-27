
class Parser {
    constructor(vocabulary = {}) {
        this.noiseWords = new Set(["the", "a", "an", "of", "at", "to", "from", "some", "with"]);
        this.vocabulary = vocabulary;
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
        
        if (!canonicalAction) canonicalAction = rawVerb;
        
        if (canonicalAction === "move" && !target) {
            return { action: "move", target: rawVerb };
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
        for (const [iid, idata] of Object.entries(scenarioData.items)) {
            this.items[iid] = new Item(idata);
        }
        for (const [rid, rdata] of Object.entries(scenarioData.rooms)) {
            this.rooms[rid] = new Room(rdata);
        }
    }

    getRoom() { return this.rooms[this.playerRoomId]; }

    getRoomDescription() {
        const room = this.getRoom();
        return room ? room.description : "You are in a void.";
    }

    getItem(targetName) {
        const room = this.getRoom();
        if (!room) return null;
        const matches = (item, target) => {
            if (!target) return false;
            const tLow = target.toLowerCase();
            return (item.name && item.name.toLowerCase() === tLow) || 
                   (item.id && item.id.toLowerCase() === tLow);
        };
        for (const iid of room.items) {
            const item = this.items[iid];
            if (matches(item, targetName)) return item;
        }
        for (const iid of this.playerInventory) {
            const item = this.items[iid];
            if (matches(item, targetName)) return item;
        }
        return null;
    }

    move(target) {
        const room = this.getRoom();
        if (!room) return false;
        if (target in room.exits) {
            const exitData = room.exits[target];
            if (typeof exitData === 'object') {
                const condition = exitData.condition;
                if (condition) {
                    const [key, val] = condition;
                    if ((this.state[key] || 0) < val) return "LOCKED_EXIT";
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
        if (this.state.in_combat) {
            return this._handleCombat(action, target);
        }

        if (action === "examine" && !target) {
            const room = this.getRoom();
            if (!room) return "You are nowhere.";
            const items = room.items.map(id => this.items[id].name);
            return items.length > 0 ? items.join("  ") : "Nothing here.";
        }

        if (action === "move") {
            const result = this.move(target);
            if (result === true) return this.templates.move_success.replace("{target}", target) + "\n\n" + this.getRoomDescription();
            if (result === "LOCKED_EXIT") return this.templates.move_fail;
            return this.templates.move_fail.replace("{target}", target || "unknown destination");
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
                    if ((this.state[key] || 0) < val) {
                        return interaction.fail_response || "You don't have the required skill.";
                    }
                }
                if (interaction.effect) {
                    for (const [k, v] of Object.entries(interaction.effect)) {
                        if (typeof v === 'string' && v.startsWith('+')) {
                            this.state[k] = (this.state[k] || 0) + parseInt(v.substring(1));
                        } else if (typeof v === 'string' && v.startsWith('-')) {
                            this.state[k] = (this.state[k] || 0) - parseInt(v.substring(1));
                        } else {
                            this.state[k] = v;
                        }
                    }
                }
                if (interaction.start_combat) {
                    this.state.in_combat = true;
                    this.state.combat_target = item.id;
                    return `A ${item.name} attacks! You are now in combat. Commands: attack, flee.`;
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
        if (action === "examine") {
            return item.description;
        }

        return this.templates.cant_do.replace("{verb}", action).replace("{item}", item.name);
    }

    _handleCombat(action, target) {
        const targetId = this.state.combat_target;
        const targetItem = this.items[targetId];
        if (!targetItem) {
            this.state.in_combat = false;
            return "The enemy has vanished.";
        }

        if (action === "flee") {
            this.state.in_combat = false;
            return "You managed to escape the fight!";
        }

        if (action === "attack") {
            const strLevel = this.state.strength || 1;
            let enemyHp = targetItem.properties.hp || 10;
            const damage = strLevel + 1;
            
            enemyHp -= damage;
            targetItem.properties.hp = enemyHp;
            
            let logMsg = `You hit the ${targetItem.name} for ${damage} damage!`;
            
            if (enemyHp <= 0) {
                this.state.in_combat = false;
                const xpGain = targetItem.properties.xp || 10;
                this.state.combat_xp = (this.state.combat_xp || 0) + xpGain;
                return `${logMsg}\n The ${targetItem.name} is defeated! You gain ${xpGain} combat XP.`;
            }
            
            const enemyStr = targetItem.properties.strength || 1;
            let playerHp = this.state.hp || 100;
            const playerDamage = enemyStr;
            playerHp -= playerDamage;
            this.state.hp = playerHp;
            
            logMsg += ` The ${targetItem.name} hits you back for ${playerDamage} damage. (Your HP: ${playerHp})`;
            
            if (playerHp <= 0) {
                return `${logMsg}\n You have been defeated! You wake up in the town square.`;
            }
            
            return logMsg;
        }

        return "In combat, you can only 'attack' or 'flee'.";
    }

    _doTake(item) {
        const room = this.getRoom();
        if (room && room.items.includes(item.id)) {
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
        return this.templates.open_success?.replace("{item}", item.name) || `You open the ${item.name}.`;
    }
}
