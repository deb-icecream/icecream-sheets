/**
 * Wave 3: tests for engine-implemented Excel functions
 * (XLOOKUP, TEXTJOIN, AVERAGEIFS, database functions, etc.)
 */
export const WAVE3 = [
  // XLOOKUP
  ['XLOOKUP("b",Lookup!A1:A4,Lookup!C1:C4)', 'number'],
  ['XLOOKUP("z",Lookup!A1:A4,Lookup!C1:C4,"missing")', 'string'],
  ['XLOOKUP("z",Lookup!A1:A4,Lookup!C1:C4)', null], // #N/A expected, smoke
  // TEXTJOIN
  ['TEXTJOIN(",",TRUE(),"a","","b","c")', 'string'],
  ['TEXTJOIN("-",FALSE(),"x","y")', 'string'],
  // AVERAGEIFS
  ['AVERAGEIFS(Stats!A1:A5,Stats!A1:A5,">10")', 'number'],
  // ERROR.TYPE / TYPE
  ['ERROR.TYPE(1/0)', 'number'],
  ['TYPE(123)', 'number'], ['TYPE("abc")', 'number'], ['TYPE(TRUE())', 'number'],
  // FIXED
  ['FIXED(1234.567,2)', 'string'],
  // RANK.EQ
  ['RANK.EQ(20,Stats!A1:A5)', 'number'],
  // LOOKUP
  ['LOOKUP(12,Stats!A1:A5,Stats!A1:A5)', 'number'],
  // Database (uses DbData sheet)
  ['DSUM(DbData!A1:B4,"Sales",DbCrit!A1:A2)', 'number'],
  ['DAVERAGE(DbData!A1:B4,"Sales",DbCrit!A1:A2)', 'number'],
  ['DCOUNT(DbData!A1:B4,"Sales",DbCrit!A1:A2)', 'number'],
  ['DMAX(DbData!A1:B4,"Sales",DbCrit!A1:A2)', 'number'],
  ['DMIN(DbData!A1:B4,"Sales",DbCrit!A1:A2)', 'number'],
];
