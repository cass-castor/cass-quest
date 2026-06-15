
class Item {
    constructor(id, data) {
        this.id = id;
        this.name = data.name || id;
        this.description = data.description || "";
        this.takeable = data.takeable !== undefined ? data.takeable : true;
    }
}

class Room {
    constructor(id, data) {
        this.id = id;
        this.name = data.name || id;
        this.description = data.description || "";
        this.asciiArt = data.art || "";
        this.exits = data.exits || {};
        this.itemIds = data.items || [];
    }

    getDescription(world) {
        let desc = "";
        if (this.asciiArt) {
            desc += this.asciiArt + "\n";
        }
        desc += `\n--- ${this.name} ---\n${this.description}\n`;

        const roomItems = this.itemIds
            .filter(iid => world.items[iid])
            .map(iid => world.items[iid].name);

        if (roomItems.length > 0) {
            desc += `You see: ${roomItems.join(", ")}\n`;
        }

        const exitsList = Object.keys(this.exits).join(", ");
        desc += `Exits: ${exitsList}`;
        return desc;
    }
}

class Player {
    constructor(startRoomId, initialOxygen) {
        this.currentRoomId = startRoomId;
        this.inventory = []; 
        this.oxygen = initialOxygen;
    }

    move(direction, world) {
        const room = world.rooms[this.currentRoomId];
        if (!room) {
            console.error(`Room ${this.currentRoomId} not found in world.`);
            return false;
        }
        if (room.exits && room.exits[direction]) {
            const nextRoomId = room.exits[direction];
            if (world.rooms[nextRoomId]) {
                this.currentRoomId = nextRoomId;
                this.oxygen -= 1;
                return true;
            } else {
                console.error(`Exit ${direction} leads to non-existent room ${nextRoomId}.`);
            }
        }
        return false;
    }

    take(itemName, world) {
        const room = world.rooms[this.currentRoomId];
        if (!room) return null;
        for (const iid of room.itemIds) {
            const item = world.items[iid];
            if (item && item.name.toLowerCase() === itemName.toLowerCase() && item.takeable) {
                room.itemIds = room.itemIds.filter(id => id !== iid);
                this.inventory.push(iid);
                return item;
            }
        }
        return null;
    }
}

class World {
    constructor(data) {
        this.data = data;
        this.gameName = data.game_name || "Unknown Game";
        this.startRoom = data.start_room;
        this.initialOxygen = data.initial_oxygen || 20;
        this.state = data.world_state || {};

        this.rooms = {};
        if (data.rooms) {
            for (const [rid, rdata] of Object.entries(data.rooms)) {
                this.rooms[rid] = new Room(rid, rdata);
            }
        }

        this.items = {};
        if (data.items) {
            for (const [iid, idata] of Object.entries(data.items)) {
                this.items[iid] = new Item(iid, idata);
            }
        }

        this.interactions = data.interactions || [];
    }

    handleInteraction(action, itemId, player) {
        for (const inter of this.interactions) {
            if (inter.item === itemId && inter.action === action) {
                if (inter.room && inter.room !== player.currentRoomId) {
                    continue;
                }

                const reqFlag = inter.required_flag;
                if (reqFlag && !this.state[reqFlag]) {
                    if (itemId === "console" || (itemId === "keycard" && this.state["power_on"])) {
                        return { success: false, message: "The console is dead. It needs power first." };
                    } else {
                        return { success: false, message: "You can't do that right now." };
                    }
                }

                if (inter.set_flag) {
                    Object.assign(this.state, inter.set_flag);
                }

                if (inter.effect === "restore_oxygen") {
                    player.oxygen += inter.amount || 0;
                }

                if (inter.consume_item && player.inventory.includes(itemId)) {
                    player.inventory = player.inventory.filter(id => id !== itemId);
                }

                return { 
                    success: true, 
                    message: inter.message || "", 
                    winGame: inter.win_game || false 
                };
            }
        }
        return { success: false, message: "You can't use that here." };
    }
}
