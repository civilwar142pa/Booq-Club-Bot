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
    
    // Check if we got a valid response before parsing
    if (!text || text.length < 50) {
      throw new Error('Invalid response from Google Sheets');
    }
    
    // Parse the Google Visualization API response (removes wrapper)
    const jsonData = JSON.parse(text.substring(47).slice(0, -2));
    
    // Check if we have valid data structure
    if (!jsonData.table || !jsonData.table.rows) {
      throw new Error('Invalid data structure from Google Sheets');
    }
    
    const rows = jsonData.table.rows;
    
    // Convert to simple array format - handle empty cells properly
    const values = rows.map(row => {
      if (!row.c) return [];
      return row.c.map(cell => {
        // Handle different cell value types
        if (cell === null) return '';
        if (cell.v !== undefined) return cell.v;
        if (cell.f !== undefined) return cell.f;
        return '';
      });
    }).filter(row => row.length > 0); // Remove empty rows
    
    console.log(`✅ Successfully fetched ${values.length} rows from public sheet`);
    
    // Ensure we have at least headers
    if (values.length === 0) {
      return getSampleData();
    }
    
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
    ['Title', 'Author', 'Status', 'Link', 'Rating'],
    ['The Current Book', 'Current Author', 'currently reading', '', ''],
    ['Future Book Option 1', 'Author One', 'future option', '', ''],
    ['Future Book Option 2', 'Author Two', 'future option', '', ''],
    ['Completed Book', 'Past Author', 'finished', '', '4.5']
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