
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
        this.playerGold = this.state.initial_gold || 10;
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
        this.npcs = {}; 
        this.worldTime = 0;

        for (const [iid, idata] of Object.entries(scenarioData.items)) {
            this.items[iid] = new Item(idata);
        }
        for (const [rid, rdata] of Object.entries(scenarioData.rooms)) {
            this.rooms[rid] = new Room(rdata);
        }
        
        if (scenarioData.npcs) {
            for (const [nid, ndata] of Object.entries(scenarioData.npcs)) {
                this.npcs[nid] = {
                    ...ndata,
                    currentRoom: ndata.start_room,
                    inventory: ndata.initial_inventory || [],
                    gold: ndata.initial_gold || 20,
                    state: ndata.initial_state || {},
                    beliefs: {} 
                };
                for (const rid in this.rooms) {
                    this.npcs[nid].beliefs[rid] = 0.1;
                }
            }
        }
    }

    getRoom() { return this.rooms[this.playerRoomId]; }

    getRoomDescription() {
        const room = this.getRoom();
        if (!room) return "You are in a void.";
        let desc = room.description;
        const presentNpcs = Object.entries(this.npcs)
            .filter(([id, npc]) => npc.currentRoom === this.playerRoomId)
            .map(([id, npc]) => npc.name);
        if (presentNpcs.length > 0) {
            desc += "\n\nPeople here: " + presentNpcs.join(", ");
        }
        return desc;
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
            if (result === true) return this.templates.move_success.replace("{target}", target);
            if (result === "LOCKED_EXIT") return this.templates.move_fail;
            return this.templates.move_fail.replace("{target}", target || "unknown destination");
        }

        // Trading logic (Player to NPC)
        if (action === "trade") {
            const npc = this._getNpcByName(target);
            if (!npc) return `There is no one named ${target} here to trade with.`;
            
            const npcItems = npc.inventory.map(id => this.items[id].name).join(", ") || "nothing";
            return `${npc.name} says: "I have ${npcItems}. I'll trade a resource for 5 gold."`;
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

    _getNpcByName(name) {
        const room = this.getRoom();
        if (!room) return null;
        for (const [id, npc] of Object.entries(this.npcs)) {
            if (npc.currentRoom === this.playerRoomId && npc.name.toLowerCase() === name.toLowerCase()) {
                return npc;
            }
        }
        return null;
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
            return this.templates.already_open?.replace("{item}", item.name) || `The {item} is already open.`;
        }
        item.properties.is_open = true;
        return this.templates.open_success?.replace("{item}", item.name) || `You open the ${item.name}.`;
    }

    tick() {
        this.worldTime++;
        const events = [];

        // 1. Handle NPC Interactions (Social layer)
        for (const [id, npc] of Object.entries(this.npcs)) {
            const room = this.rooms[npc.currentRoom];
            const others = Object.entries(this.npcs).filter(([oid, onpc]) => onpc.currentRoom === npc.currentRoom && oid !== id);
            
            if (others.length > 0 && npc.state.hunger && npc.state.hunger > 30) {
                const other = others[0][1];
                const foodItem = other.inventory.find(iid => this.items[iid] && this.items[iid].properties.food);
                
                if (foodItem && npc.gold >= 5) {
                    // Trade: NPC buys food from other NPC
                    npc.gold -= 5;
                    other.gold += 5;
                    npc.inventory.push(foodItem);
                    other.inventory = other.inventory.filter(iid => iid !== foodItem);
                    
                    events.push(`${npc.name} traded 5 gold to ${other.name} for a ${this.items[foodItem].name}.`);
                }
            }
        }

        // 2. Handle NPC Movement (Active Inference)
        for (const [id, npc] of Object.entries(this.npcs)) {
            const room = this.rooms[npc.currentRoom];
            if (!room) continue;

            if (npc.state.hunger && npc.state.hunger > 50) {
                const food = room.items.find(id => this.items[id] && this.items[id].properties.food);
                if (food) {
                    npc.state.hunger = 0;
                    room.items = room.items.filter(id => id !== food);
                    npc.inventory.push(food);
                    events.push(`${npc.name} found food and ate it. Hunger satisfied.`);
                } else {
                    const exits = Object.keys(room.exits);
                    if (exits.length > 0) {
                        let bestDir = null;
                        let maxBelief = -1;
                        for (const dir of exits) {
                            const destId = typeof room.exits[dir] === 'string' ? room.exits[dir] : room.exits[dir].dest;
                            if (npc.beliefs[destId] > maxBelief) {
                                maxBelief = npc.beliefs[destId];
                                bestDir = dir;
                            }
                        }
                        if (bestDir) {
                            const destId = typeof room.exits[bestDir] === 'string' ? room.exits[bestDir] : room.exits[bestDir].dest;
                            npc.currentRoom = destId;
                            const newRoom = this.rooms[destId];
                            const foundFood = newRoom.items.find(id => this.items[id] && this.items[id].properties.food);
                            if (foundFood) npc.beliefs[destId] += 0.2;
                            else npc.beliefs[destId] -= 0.05;
                            events.push(`${npc.name} is searching for food and moved ${bestDir} to ${newRoom.name}.`);
                        }
                    }
                }
            } else if (Math.random() < 0.2) {
                const exits = Object.keys(room.exits);
                if (exits.length > 0) {
                    const direction = exits[Math.floor(Math.random() * exits.length)];
                    const dest = room.exits[direction];
                    const destId = typeof dest === 'string' ? dest : dest.dest;
                    npc.currentRoom = destId;
                    events.push(`${npc.name} wandered ${direction} to ${this.rooms[destId].name}.`);
                }
            }

            npc.state.hunger = (npc.state.hunger || 0) + 1;
        }

        return events;
    }
}
