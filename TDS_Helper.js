// ==========================================
// TDS DATA HELPER
// param %par1: The file/key structure (e.g., "Itin_Master:0:departUnix")
// param %par2: Optional value to set.
// ==========================================

try {
    var input = String(local('par1')).split(":"); // Format: "Filename:Index:Key"
    var fileName = input[0];
    var targetIdx = parseInt(input[1]);
    var targetKey = input[2];
    var newValue = local('par2');

    var filePath = "Tasker/Tesla/Data/" + fileName + ".json";
    var rawFile = readFile(filePath) || "[]";
    var data = JSON.parse(rawFile);

    if (newValue === "") {
        // GETTER: Return the requested value
        setLocal('return_value', data[targetIdx][targetKey]);
    } else {
        // SETTER: Update the value and save
        data[targetIdx][targetKey] = newValue;
        writeFile(filePath, JSON.stringify(data), false);
        setLocal('return_value', "SUCCESS");
    }
} catch(e) {
    setLocal('return_value', "ERROR: " + e.message);
}
