function copyContract() {
  const contract =
    "0x2E9803942dAf364a803f4C01D3E49D431dDf1421";

  navigator.clipboard.writeText(contract).then(() => {
    alert("YST contract address copied.");
  });
}