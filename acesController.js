// acesController.js
const { spawn } = require("child_process");
const path = require("path");

const generateAcesResponse = async (req, res) => {
  const { userMessage } = req.body;

  // 1. Define the Python script path and arguments
  const pythonScript = path.join(__dirname, "generate.py");

  // 2. Spawn a child process to run the Python script
  // Ensure you use 'python' or 'python3' depending on your system setup
  const pythonProcess = spawn("python", [pythonScript, userMessage]);

  let acesReply = "";
  let errorOutput = "";

  // 3. Listen for data from the Python script's stdout
  pythonProcess.stdout.on("data", (data) => {
    acesReply += data.toString();
  });

  // 4. Listen for any errors from the Python script's stderr
  pythonProcess.stderr.on("data", (data) => {
    errorOutput += data.toString();
    console.error(`Python Script Error: ${data}`);
  });

  // 5. Handle the process exit event
  pythonProcess.on("close", (code) => {
    if (code !== 0) {
      // If the script exited with an error code
      console.error(`Python script exited with code ${code}`);
      return res.status(500).json({
        success: false,
        error:
          "A.c.e.s AI (Custom Model) encountered an error. Have you run train.py?",
        details: errorOutput,
      });
    }

    // 6. Send the successful reply back to the frontend
    res.status(200).json({
      success: true,
      reply: acesReply.trim(), // Trim any extra whitespace
    });
  });
};

module.exports = { generateAcesResponse };
