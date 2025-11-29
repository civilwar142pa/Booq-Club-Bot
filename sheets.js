const fetch = require('node-fetch');

const SPREADSHEET_ID = '1TRraVAkBbpZHz0oLLe0TRkx9i8F4OwAUMkP4gm74nYs';

async function getSheetData(range = 'Blad1') {
  try {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY environment variable required');
    }

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}?key=${apiKey}`;
    
    console.log('Fetching sheet data from:', `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}?key=***`);
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (!response.ok) {
      console.error('Sheets API error:', data.error);
      throw new Error(data.error?.message || 'Failed to fetch sheet data');
    }
    
    console.log('Successfully fetched', data.values?.length || 0, 'rows from sheet');
    return data.values || [];
  } catch (error) {
    console.error('Error fetching sheet data:', error);
    throw new Error(`Failed to access Google Sheets: ${error.message}`);
  }
}

async function getSheetInfo() {
  try {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY environment variable required');
    }

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?key=${apiKey}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error?.message || 'Failed to fetch sheet info');
    }
    
    return data;
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