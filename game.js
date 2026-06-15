
async function startGame(scenarioId) {
    const output = document.getElementById('terminal-output');
    const inputArea = document.getElementById('terminal-input-area');
    const container = document.getElementById('terminal-container');
    
    output.innerHTML = "Loading scenario...";
    container.style.display = 'flex';
    inputArea.style.display = 'none';

    // FIX: Strip .json from scenarioId if it exists to avoid .json.json
    const cleanId = scenarioId.replace(/\.json$/, '');
    
    try {
        const response = await fetch(`scenarios/${cleanId}.json`);
        if (!response.ok) throw new Error(`Scenario ${cleanId} not found (Status: ${response.status})`);
        const data = await response.json();
        
        const world = new World(data);
        const player = new Player(world.startRoom, world.initialOxygen);
        
        window.currentGame = { world, player };

        output.innerHTML = `Welcome to '${world.gameName}'!<br>${data.intro || "Welcome to the adventure!"}<br>Type 'help' for commands.<br>`;
        
        updateDisplay();
        inputArea.style.display = 'flex';
        document.getElementById('terminal-input').focus();
        
    } catch (e) {
        console.error(e);
        output.innerHTML = `Error loading scenario: ${e.message}`;
    }
}

function updateDisplay() {
    if (!window.currentGame) return;
    const { world, player } = window.currentGame;
    const output = document.getElementById('terminal-output');
    
    let content = `<br><span style="color: #ff00ff;">[ OXYGEN: ${player.oxygen} ]</span><br>`;
    content += world.rooms[player.currentRoomId].getDescription(world);
    
    output.innerHTML += content;
    output.scrollTop = output.scrollHeight;
}

async function handleInput(e) {
    if (e.key === 'Enter') {
        const inputField = document.getElementById('terminal-input');
        const cmdText = inputField.value.trim().toLowerCase();
        if (!cmdText) return;

        const output = document.getElementById('terminal-output');
        output.innerHTML += `<br><span style="color: #888;">&gt; ${cmdText}</span><br>`;
        inputField.value = '';

        if (!window.currentGame) return;
        const { world, player } = window.currentGame;
        const parts = cmdText.split();
        const action = parts[0];
        const args = parts.slice(1);

        let message = "";

        if (action === "help") {
            message = "Commands: go [direction], take [item], use [item], inventory, look, quit";
        } else if (action === "quit") {
            message = "Thanks for playing!";
            window.currentGame = null;
            document.getElementById('terminal-container').style.display = 'none';
            output.innerHTML += message + "<br>";
            return;
        } else if (action === "look") {
            // handled by updateDisplay
        } else if (action === "inventory") {
            if (player.inventory.length === 0) {
                message = "Your inventory is empty.";
            } else {
                const names = player.inventory.map(iid => world.items[iid].name);
                message = "You are carrying: " + names.join(", ");
            }
        } else if (action === "go") {
            if (args.length === 0) {
                message = "Go where?";
            } else {
                const dir = args[0];
                if (player.move(dir, world)) {
                    message = `You move ${dir}.`;
                    if (player.oxygen <= 0) {
                        message += `<br><br>*** GASPING FOR AIR ***<br>Your oxygen has run out. You collapse on the cold floor of the station.<br>GAME OVER.`;
                        window.currentGame = null;
                        document.getElementById('terminal-input-area').style.display = 'none';
                    }
                } else {
                    message = `You can't go ${dir} from here.`;
                }
            }
        } else if (action === "take") {
            if (args.length === 0) {
                message = "Take what?";
            } else {
                const itemName = args.join(" ");
                const item = player.take(itemName, world);
                message = item ? `You took the ${item.name}.` : "You can't take that.";
            }
        } else if (action === "use") {
            if (args.length === 0) {
                message = "Use what?";
            } else {
                const itemName = args.join(" ");
                let itemId = null;
                for (const iid of player.inventory) {
                    if (world.items[iid].name.toLowerCase() === itemName) {
                        itemId = iid;
                        break;
                    }
                }
                if (!itemId) {
                    const room = world.rooms[player.currentRoomId];
                    if (room) {
                        for (const iid of room.itemIds) {
                            if (world.items[iid].name.toLowerCase() === itemName) {
                                itemId = iid;
                                break;
                            }
                        }
                    }
                }

                if (!itemId) {
                    message = "You don't have that, and it's not here.";
                } else {
                    const result = world.handleInteraction("use", itemId, player);
                    message = result.message;
                    if (result.winGame) {
                        message += `<br><br>*** MISSION ACCOMPLISHED ***<br>You have escaped the station!<br>VICTORY!`;
                        window.currentGame = null;
                        document.getElementById('terminal-input-area').style.display = 'none';
                    }
                }
            }
        } else {
            message = "I don't understand that command.";
        }

        output.innerHTML += message + "<br>";
        if (window.currentGame) {
            updateDisplay();
        }
        output.scrollTop = output.scrollHeight;
    }
}

function closeGame() {
    document.getElementById('terminal-container').style.display = 'none';
    window.currentGame = null;
}
