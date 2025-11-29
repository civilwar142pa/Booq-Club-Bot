const { google } = require('googleapis');

const SPREADSHEET_ID = '1TRraVAkBbpZHz0oLLe0TRkx9i8F4OwAUMkP4gm74nYs';

async function getGoogleSheetsClient() {
  if (process.env.GOOGLE_API_KEY) {
    console.log('Using Google API Key for Sheets access');
    return google.sheets({ 
      version: 'v4', 
      auth: process.env.GOOGLE_API_KEY 
    });
  }
  
  throw new Error('GOOGLE_API_KEY environment variable required for Google Sheets access');
}

async function getSheetData(range = 'Blad1') {
  try {
    const sheets = await getGoogleSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: range,
    });
    return response.data.values || [];
  } catch (error) {
    console.error('Error fetching sheet data:', error);
    throw new Error(`Failed to access Google Sheets: ${error.message}`);
  }
}

async function getSheetInfo() {
  try {
    const sheets = await getGoogleSheetsClient();
    const response = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching sheet info:', error);
    throw new Error(`Failed to access Google Sheets info: ${error.message}`);
  }
}

module.exports = {
  getSheetData,
  getSheetInfo,
  SPREADSHEET_ID
};