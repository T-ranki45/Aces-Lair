// aiRoutes.js
const express = require("express");
const router = express.Router();
const { generateAcesResponse } = require("./acesController");

// Define the POST route
router.post("/chat", generateAcesResponse);

module.exports = router;
