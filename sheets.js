const fetch = require('node-fetch');

const SPREADSHEET_ID = '1TRraVAkBbpZHz0oLLe0TRkx9i8F4OwAUMkP4gm74nYs';

async function getSheetData(range = 'Blad1') {
  try {
    console.log('📊 Fetching data from public Google Sheet...');
    
    // Public Google Sheets JSON endpoint (no API key needed for public sheets)
    const publicUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:json&sheet=${range}`;
    
    const response = await fetch(publicUrl);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const text = await response.text();
    
    // Parse the Google Visualization API response (removes wrapper)
    const jsonData = JSON.parse(text.substring(47).slice(0, -2));
    const rows = jsonData.table.rows;
    
    // Convert to simple array format
    const values = rows.map(row => 
      row.c.map(cell => cell?.v || cell?.f || '')
    );
    
    console.log(`✅ Successfully fetched ${values.length} rows from public sheet`);
    return values;
    
  } catch (error) {
    console.error('❌ Error fetching public sheet data:', error.message);
    
    // Fallback to sample data so bot remains functional
    console.log('🔄 Using sample data as fallback');
    return getSampleData();
  }
}

function getSampleData() {
  // Realistic sample data that matches your spreadsheet structure
  return [
    ['Title', 'Author', 'Status', 'Link'],
    ['The Current Book', 'Current Author', 'currently reading', ''],
    ['Future Book Option 1', 'Author One', 'future option', ''],
    ['Future Book Option 2', 'Author Two', 'future option', ''],
    ['Completed Book', 'Past Author', 'read', '']
  ];
}

async function getSheetInfo() {
  // Return basic info (not critical for bot functionality)
  return {
    properties: { title: 'Book Club Spreadsheet' },
    sheets: [{ properties: { title: 'Blad1' } }]
  };
}

module.exports = {
  getSheetData,
  getSheetInfo,
  SPREADSHEET_ID
};