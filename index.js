// Import necessary modules
const express = require('express');
const cors = require('cors');
const storage = require('node-persist'); // For persistent storage
const path = require('path'); // Node.js built-in module for path manipulation

// Initialize Express app
const app = express();
const PORT = 3000; // Port for your backend server

// Middleware
app.use(cors()); // Enable CORS for all routes, allowing your frontend to connect
app.use(express.json()); // Enable parsing of JSON request bodies

// --- Serve static frontend files ---
// This line tells Express to serve files from the 'frontend' directory.
// When a request comes for '/', it will look for 'index.html' in this directory.
app.use(express.static(path.join(__dirname, 'frontend')));

// --- Game Configuration (should match frontend) ---
const ROWS = 4;
const COLS = 5;
const GROWTH_TIME_MS = 5000; // Time for a watered plant to grow to harvestable stage (5 seconds)

// --- Game State (will be loaded from storage) ---
let gameBoard = [];

/**
 * Initializes the node-persist storage and loads the game state.
 */
async function initStorageAndLoadGameState() {
    // Initialize storage with a directory to save data
    await storage.init({
        dir: 'farming-game-data', // Directory where data will be stored
        stringify: JSON.stringify, // Function to convert data to string
        parse: JSON.parse,       // Function to convert string to data
        encoding: 'utf8',
        logging: false,          // Disable logging for cleaner output
        ttl: false,              // No expiration for stored data
        forgiveParseErrors: true // Continue if there are parsing errors
    });

    // Try to retrieve the game board from storage
    const storedGameBoard = await storage.getItem('gameBoard');

    if (storedGameBoard) {
        gameBoard = storedGameBoard;
        console.log('Game board loaded from storage.');

        // Re-establish growth timeouts for any watered plants
        gameBoard.forEach((row, r) => {
            row.forEach((plot, c) => {
                if (plot.state === 'watered' && plot.lastWateredTime) {
                    const timeElapsed = Date.now() - plot.lastWateredTime;
                    const remainingGrowthTime = GROWTH_TIME_MS - timeElapsed;

                    if (remainingGrowthTime > 0) {
                        // If still growing, set a new timeout
                        plot.growthTimeout = setTimeout(async () => {
                            if (gameBoard[r][c].state === 'watered') {
                                gameBoard[r][c].state = 'ready';
                                await saveGameBoard(); // Save updated state
                                console.log(`Plant at (${r}, ${c}) is now ready (re-established timeout).`);
                            }
                        }, remainingGrowthTime);
                    } else {
                        // If growth time has passed, set to ready immediately
                        plot.state = 'ready';
                        console.log(`Plant at (${r}, ${c}) was already ready on load.`);
                    }
                }
            });
        });
    } else {
        // If no game board in storage, initialize a new one
        initializeNewGameBoard();
        console.log('New game board initialized.');
    }
}

/**
 * Initializes a new empty game board.
 */
function initializeNewGameBoard() {
    gameBoard = [];
    for (let r = 0; r < ROWS; r++) {
        gameBoard[r] = [];
        for (let c = 0; c < COLS; c++) {
            gameBoard[r][c] = {
                state: 'empty', // 'empty', 'planted', 'watered', 'ready'
                lastWateredTime: null, // Timestamp when last watered
                growthTimeout: null // Placeholder for server-side timeout ID
            };
        }
    }
    saveGameBoard(); // Save the newly initialized board
}

/**
 * Saves the current game board state to persistent storage.
 */
async function saveGameBoard() {
    // Before saving, remove the non-serializable 'growthTimeout' property
    const serializableGameBoard = gameBoard.map(row =>
        row.map(plot => {
            const newPlot = { ...plot };
            delete newPlot.growthTimeout; // Remove the timeout ID
            return newPlot;
        })
    );
    await storage.setItem('gameBoard', serializableGameBoard);
    console.log('Game board saved to storage.');
}

// --- API Endpoints ---

/**
 * GET /api/game-state
 * Returns the current state of the game board.
 */
app.get('/api/game-state', (req, res) => {
    // Send a deep copy to prevent accidental modification outside this scope
    const responseBoard = gameBoard.map(row => row.map(plot => ({ ...plot, growthTimeout: undefined })));
    res.json(responseBoard);
});

/**
 * POST /api/plant
 * Plants a seed in the specified plot.
 * Request body: { row: number, col: number }
 */
app.post('/api/plant', async (req, res) => {
    const { row, col } = req.body;

    // Validate input
    if (row === undefined || col === undefined || row < 0 || row >= ROWS || col < 0 || col >= COLS) {
        return res.status(400).json({ success: false, message: 'Invalid plot coordinates.' });
    }

    const plot = gameBoard[row][col];

    if (plot.state === 'empty') {
        plot.state = 'planted';
        plot.lastWateredTime = null; // Ensure no stale water time
        if (plot.growthTimeout) { // Clear any old timeout if it exists (shouldn't for empty)
            clearTimeout(plot.growthTimeout);
            plot.growthTimeout = null;
        }
        await saveGameBoard();
        res.json({ success: true, message: `Seed planted at (${row}, ${col}).` });
    } else {
        res.status(400).json({ success: false, message: 'Plot is not empty.' });
    }
});

/**
 * POST /api/water
 * Waters the plant in the specified plot, starting its growth timer.
 * Request body: { row: number, col: number }
 */
app.post('/api/water', async (req, res) => {
    const { row, col } = req.body;

    // Validate input
    if (row === undefined || col === undefined || row < 0 || row >= ROWS || col < 0 || col >= COLS) {
        return res.status(400).json({ success: false, message: 'Invalid plot coordinates.' });
    }

    const plot = gameBoard[row][col];

    if (plot.state === 'planted') {
        plot.state = 'watered';
        plot.lastWateredTime = Date.now(); // Record watering time

        // Clear any existing timeout for this plot to prevent multiple timers
        if (plot.growthTimeout) {
            clearTimeout(plot.growthTimeout);
        }

        // Set a timeout for the plant to become 'ready'
        plot.growthTimeout = setTimeout(async () => {
            // Check if the plot is still in 'watered' state before changing to 'ready'
            // This handles cases where it might have been harvested or re-planted before growth completed
            if (gameBoard[row][col].state === 'watered') {
                gameBoard[row][col].state = 'ready';
                gameBoard[row][col].growthTimeout = null; // Clear timeout reference
                await saveGameBoard(); // Save the updated state
                console.log(`Server: Plant at (${row}, ${col}) is now ready.`);
            }
        }, GROWTH_TIME_MS);

        await saveGameBoard(); // Save the state immediately after watering
        res.json({ success: true, message: `Plant at (${row}, ${col}) watered. It will be ready in ${GROWTH_TIME_MS / 1000} seconds.` });
    } else if (plot.state === 'watered' || plot.state === 'ready') {
        res.status(400).json({ success: false, message: 'Plant is already watered or ready.' });
    } else {
        res.status(400).json({ success: false, message: 'Nothing to water here. Plant a seed first!' });
    }
});

/**
 * POST /api/harvest
 * Harvests the plant in the specified plot.
 * Request body: { row: number, col: number }
 */
app.post('/api/harvest', async (req, res) => {
    const { row, col } = req.body;

    // Validate input
    if (row === undefined || col === undefined || row < 0 || row >= ROWS || col < 0 || col >= COLS) {
        return res.status(400).json({ success: false, message: 'Invalid plot coordinates.' });
    }

    const plot = gameBoard[row][col];

    if (plot.state === 'ready') {
        plot.state = 'empty';
        plot.lastWateredTime = null;
        if (plot.growthTimeout) { // Clear any pending growth timeout
            clearTimeout(plot.growthTimeout);
            plot.growthTimeout = null;
        }
        await saveGameBoard();
        res.json({ success: true, message: `Plant at (${row}, ${col}) harvested.` });
    } else if (plot.state === 'empty') {
        res.status(400).json({ success: false, message: 'Nothing to harvest here. Plot is empty!' });
    } else {
        res.status(400).json({ success: false, message: 'Plant is not ready to harvest yet.' });
    }
});

// --- Server Start ---
// Initialize storage and then start the server
initStorageAndLoadGameState().then(() => {
    app.listen(PORT, () => {
        console.log(`Farming game backend listening at http://localhost:${PORT}`);
        console.log('Remember to update your frontend to fetch data from this backend!');
    });
}).catch(error => {
    console.error('Failed to initialize storage or load game state:', error);
    process.exit(1); // Exit if storage initialization fails
});