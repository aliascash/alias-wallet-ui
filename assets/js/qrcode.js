var showQRCode;

$(function() {
  function parse(address, label) {
    if (void 0 !== address) {
      qraddress.val(address);
    }
    if (void 0 !== label) {
      qrlabel.val(label);
    }
    handler.clear();
    var e = encodeURI("alias:" + qraddress.val() + "?label=" + qrlabel.val() + "&narration=" + qrnarration.val() + "&amount=" + unit.format(unit.parse($("#qramount").val(), $("#qrunit").val()),0));
    errors.text(e);
    handler.makeCode(e);
  }
  var handler = new QRCode("qrcode", {
    colorDark: "#E51C39",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.H,
    width: 220,
    height: 220
  });
  var errors = $("#qrcode-data");
  var qraddress = $("#qraddress");
  var qrlabel = $("#qrlabel");
  var qrnarration = $("#qrnarration");
  showQRCode = parse;

  $("#qramount").on("keydown", unit.keydown).on("paste", unit.paste);
});