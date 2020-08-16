function invalid(name, color) {
  return color === true ? name.css("background", "").css("color", "") : name.css("background", "#155b9a").css("color", "white"), 1 == color;
}
function updateValue(button) {
  function complete(status) {
    var $field = $(".newval");
    if (0 !== $field.length) {
      button.html(names.replace(name, $field.val().trim()));
    }
  }
  $("#tooltip").remove();
  var names = button.html();
  var name = void 0 !== button.parent("td").data("label") ? button.parent("td").data("label") : void 0 !== button.parent("td").data("value") ? button.parent("td").data("value") : void 0 !== button.data("label") ? button.data("label") : void 0 !== button.data("value") ? button.data("value") : button.text();
  var result = button.parents(".selected").find(".address");
  var selected = button.parents(".selected").find(".addresstype");
  result = result.data("value") ? result.data("value") : result.text();
  if (1 === selected.length) {
    selected = selected.data("value") ? selected.data("value") : selected.text();
  }
  button.html('<input class="newval" type="text" onchange="bridge.updateAddressLabel(\'' + result + '\', this.value);" value="' + name + '" size=60 />');
  $(".newval").focus().on("contextmenu", function(event) {
    event.stopPropagation();
  }).keyup(function(e) {
    if (13 == e.keyCode) {
      complete(e);
    }
  });
  $(document).one("click", complete);
}
var connectSignalsAttempts = 0;
function connectSignals() {
  if (typeof(bridge) == "undefined" || typeof(optionsModel) == "undefined" || typeof(walletModel) == "undefined") {
    connectSignalsAttempts += 1;
    if (connectSignalsAttempts < 50) {
      console.log("retrying connecting signals in 200ms");
      setTimeout(connectSignals, 200);
    }
    else {
      console.log("giving up on connecting signals.");
      console.log("bridge available: "+ (typeof bridge !== "undefined"));
      console.log("optionsModel available: "+ (typeof optionsModel !== "undefined"));
      console.log("walletModel available: "+ (typeof walletModel !== "undefined"));
    }
    return;
  }

  bridge.emitPaste.connect(pasteValue);
  bridge.emitTransactions.connect(appendTransactions);
  bridge.emitAddresses.connect(appendAddresses);
  bridge.emitCoinControlUpdate.connect(updateCoinControlInfo);
  bridge.triggerElement.connect(triggerElement);
  bridge.emitReceipient.connect(addRecipientDetail);
  bridge.networkAlert.connect(networkAlert);
  bridge.getAddressLabelResult.connect(getAddressLabelResult);
  bridge.newAddressResult.connect(newAddressResult);
  bridge.lastAddressErrorResult.connect(lastAddressErrorResult);
  bridge.getAddressLabelForSelectorResult.connect(getAddressLabelForSelectorResult);

  blockExplorerPage.connectSignals();
  walletManagementPage.connectSignals();
  optionsPage.connectSignals();
  chainDataPage.connectSignals();


  bridge.validateAddressResult.connect(validateAddressResult);
  bridge.addRecipientResult.connect(addRecipientResult);
  bridge.sendCoinsResult.connect(sendCoinsResult);
  bridge.transactionDetailsResult.connect(transactionDetailsResult);

  optionsModel.displayUnitChanged.connect(unit_setType);
  optionsModel.reserveBalanceChanged.connect(updateReserved);
  optionsModel.rowsPerPageChanged.connect(updateRowsPerPage);
  optionsModel.visibleTransactionsChanged.connect(visibleTransactions);

  walletModel.encryptionStatusChanged.connect(encryptionStatusChanged);
  walletModel.balanceChanged.connect(updateBalance);

  overviewPage.clientInfo();
  optionsPage.update();
  chainDataPage.updateAnonOutputs();

  sendPage.init();

  translateStrings();

  bridge.jsReady();
}

function transactionDetailsResult(result) {
    $("#transaction-info").html(result);
}

var numOfRecipients = undefined;

function validateAddressResult(result) {
    // not in use currently
}

function sendCoinsResult(result) {
    console.log('sendCoinsResult')
    console.log(result)
    sendPage.update(result, undefined);
}


function addRecipientResult(result) {
    sendPage.update(undefined, result);
}


function encryptionStatusChanged(status) {
    overviewPage.encryptionStatusChanged(status)
}

function unit_setType(unitType) {
    unit.setType(unitType)
}

function updateCoinControlInfo(quantity, amount, fee, afterfee, bytes, priority, low, change) {
    sendPage.updateCoinControlInfo(quantity, amount, fee, afterfee, bytes, priority, low, change)
}

function addRecipientDetail(address, label, narration, amount) {
    sendPage.addRecipientDetail(address, label, narration, amount)
}

function updateReserved(name) {
    overviewPage.updateReserved(name);
}

function updateBalance(balance, spectreBal, stake, spectreStake, unconfirmed, spectreUnconfirmed, immature, spectreImmature) {
    overviewPage.updateBalance(balance, spectreBal, stake, spectreStake, unconfirmed, spectreUnconfirmed, immature, spectreImmature);
}

function triggerElement($window, completeEvent) {
  $($window).trigger(completeEvent);
}
function updateRowsPerPage(pageSize) {
  $(".footable").each(function() {
    var $target = $(this);
    if (!$target.hasClass("footable-lookup")) {
      $target.data().pageSize = pageSize;
      $target.trigger("footable_initialize");
    }
  });
}
function pasteValue(coords) {
  $(pasteTo).val(coords);
}
function paste(vim) {
  pasteTo = vim;
  bridge.paste();
  if (!(0 != pasteTo.indexOf("#pay_to") && "#change_address" != pasteTo)) {
    base58.check(pasteTo);
  }
}
function copy(obj, v) {
  var message = "";
  try {
    message = $(obj).text();
  } catch (e) {
  }
  if (!(void 0 != message && void 0 == v)) {
    message = "copy" == v ? obj : $(obj).attr(v);
  }
  bridge.copy(message);
}
function networkAlert(time) {
  $("#network-alert span").text(time).toggle("" !== time);
}
function openContextMenu(connection) {
  if (contextMenus.indexOf(connection) === -1) {
    contextMenus.push(connection);
  }
  if (void 0 !== connection.isOpen) {
    if (1 === connection.isOpen) {
      connection.isOpen = 0;
      if (connection.close) {
        connection.close();
      }
    }
  }
  var i = 0;
  for (;i < contextMenus.length;++i) {
    contextMenus[i].isOpen = contextMenus[i] == connection ? 1 : 0;
  }
}
function receivePageInit() {
  var r20 = [{
    name : "Copy&nbsp;Address",
    fun : function() {
      copy("#receive .footable .selected .address");
    }
  }, {
    name : "Copy&nbsp;Label",
    fun : function() {
      copy("#receive .footable .selected .label2");
    }
  }, {
    name : "Copy&nbsp;Public&nbsp;Key",
    fun : function() {
      copy("#receive .footable .selected .pubkey");
    }
  }, {
    name : "Edit",
    fun : function() {
      $("#receive .footable .selected .label2.editable").dblclick();
    }
  }];
  $("#receive .footable tbody").on("contextmenu", function(ev) {
    $(ev.target).closest("tr").click();
  }).contextMenu(r20, {
    triggerOn : "contextmenu",
    sizeStyle : "content"
  });
  $("#filter-address").on("input", function() {
    var $table = $("#receive-table");
    if ("" === $("#filter-address").val()) {
      $table.data("footable-filter").clearFilter();
    }
    $("#receive-filter").val($("#filter-address").val() + " " + $("#filter-addresstype").val());
    $table.trigger("footable_filter", {
      filter : $("#receive-filter").val()
    });
  });
  $("#filter-addresstype").change(function() {
    var $table = $("#receive-table");
    if ("" === $("#filter-addresstype").val()) {
      $table.data("footable-filter").clearFilter();
    }
    $("#receive-filter").val($("#filter-address").val() + " " + $("#filter-addresstype").val());
    $table.trigger("footable_filter", {
      filter : $("#receive-filter").val()
    });
  });
}
function clearRecvAddress() {
  $("#new-address-label").val("");
  $("#new-addresstype").val(1);
  $("#new-recv-address-error").text("");
}
function addAddress() {
  console.log('addAddress');
  var throughArgs = $("#new-addresstype").val();
  var r20 = $("#new-address-label").val();
  bridge.newAddress(r20, throughArgs, '', false);
}

function clearSendAddress() {
  $("#new-send-label").val("");
  $("#new-send-address").val("");
  $("#new-send-address-error").text("");
  $("#new-send-address").removeClass("inputError");
}

function getAddressLabelForSelectorResult(result, selector, fallback) {
  if (!result) {
    result = fallback;
  }
  $(selector).val(result).text(result).change();
}

function addSendAddress() {
  var udataCur = $("#new-send-address").val()
  bridge.getAddressLabelAsync(udataCur);
}

function getAddressLabelResult(result) {
  console.log("getAddressLabelResult");
  var udataCur = result;
  var name;
  var g;
  var data;
  if (name = $("#new-send-label").val(), udataCur = $("#new-send-address").val(), g = result, "" !== g) {
    return $("#new-send-address-error").text('Error: address already in addressbook under "' + g + '"'), void $("#new-send-address").addClass("inputError");
  }
  var camelKey = 0;
  bridge.newAddress(name, camelKey, udataCur, true);
}
function newAddressResult(success, errorMsg, address, send) {
  if (success) {
    $("#add-address-modal").modal("hide");
  } else {
    if (send) {
      lastAddressErrorResult(errorMsg);
    }
    else {
      $("#new-recv-address-error").text("Error: " + errorMsg);
    }
  }
}

function lastAddressErrorResult(result) {
  var to = result;
  $("#new-send-address-error").text("Error: " + to);
  $("#new-send-address").addClass("inputError");
}

function addressBookInit() {
  var r20 = [{
    name : "Copy&nbsp;Address",
    fun : function() {
      copy("#addressbook .footable .selected .address");
    }
  }, {
    name : "Copy&nbsp;Public&nbsp;Key",
    fun : function() {
      copy("#addressbook .footable .selected .pubkey");
    }
  }, {
    name : "Copy&nbsp;Label",
    fun : function() {
      copy("#addressbook .footable .selected .label2");
    }
  }, {
    name : "Edit",
    fun : function() {
      $("#addressbook .footable .selected .label2.editable").dblclick();
    }
  }, {
    name : "Delete",
    fun : function() {
      var target = $("#addressbook .footable .selected .address");
      bridge.deleteAddress(target.text())
      target.closest("tr").remove();
    }
  }];
  $("#addressbook .footable tbody").on("contextmenu", function(ev) {
    $(ev.target).closest("tr").click();
  }).contextMenu(r20, {
    triggerOn : "contextmenu",
    sizeStyle : "content"
  });
  $("#filter-addressbook").on("input", function() {
    var $table = $("#addressbook-table");
    if ("" == $("#filter-addressbook").val()) {
      $table.data("footable-filter").clearFilter();
    }
    $("#addressbook-filter").val($("#filter-addressbook").val() + " " + $("#filter-addressbooktype").val());
    $table.trigger("footable_filter", {
      filter : $("#addressbook-filter").val()
    });
  });
  $("#filter-addressbooktype").change(function() {
    var $table = $("#addressbook-table");
    if ("" == $("#filter-addresstype").val()) {
      $table.data("footable-filter").clearFilter();
    }
    $("#addressbook-filter").val($("#filter-addressbook").val() + " " + $("#filter-addressbooktype").val());
    $table.trigger("footable_filter", {
      filter : $("#addressbook-filter").val()
    });
  });
}
function appendAddresses(err) {
  console.log("appending an address: " + err);
  if ("string" == typeof err) {
    if ("[]" == err) {
      return;
    }
    err = JSON.parse(err.replace(/,\]$/, "]"));
  }
  err.forEach(function(item) {
    var revisionCheckbox = $("#" + item.address);
    var target = "S" == item.type ? "#addressbook" : "#receive";
    if ("R" == item.type) {
      if (sendPage.initSendBalance(item)) {
        if (item.address.length < 75) {
          if (0 == revisionCheckbox.length) {
            $("#message-from-address").append("<option title='" + item.address + "' value='" + item.address + "'>" + item.label + "</option>");
          } else {
            $("#message-from-address option[value=" + item.address + "]").text(item.label);
          }
        }
      }
    }
    var param = "S" == item.type;
    var common = "n/a" !== item.pubkey;
    if (0 == revisionCheckbox.length) {
      $(target + " .footable tbody").append("<tr id='" + item.address + "' lbl='" + item.label + "'> <td data-toggle=true></td>     <td>           <span class='label2 editable' data-value='" + item.label_value + "'>" + item.label + "</span> </td>                <td class='address'>" + item.address + "</td>                 <td class='pubkey'>" + item.pubkey + "</td>                 <td class='addresstype'>" + (4 == item.at ? "Group" : 3 == item.at ? "BIP32" : 2 == item.at ? "Private" : "Public") + "</td></tr>");
      $("#address-lookup-table.footable tbody").append("<tr id='" + item.address + "' lbl='" + item.label + "' class='addressType"+ item.type +"'> <td data-toggle=true></td>                 <td><span class='label2' data-value='" + item.label_value + "'>" + item.label + "</span></td>                 <td class='address'>" + item.address + "</td>                 <td class='addresstype'>" + (4 == item.at ? "Group" : 3 == item.at ? "BIP32" : 2 == item.at ? "Private" : "Public") + "</td></tr>");
      $(target + " #" + item.address).selection("tr").find(".editable").on("dblclick", function(event) {
        event.stopPropagation();
        updateValue($(this));
      }).attr("data-title", "Double click to edit").tooltip();
    } else {
      $("#" + item.address + " .label2").data("value", item.label_value).text(item.label);
      $("#" + item.address + " .pubkey").text(item.pubkey);
    }
  });
  $("#addressbook .footable, #receive .footable").trigger("footable_setup_paging");
}
function addressLookup(pair, dataAndEvents, coords) {
  function clear() {
    $("#address-lookup-filter").val($("#address-lookup-address-filter").val() + " " + $("#address-lookup-address-type").val());
    $table.trigger("footable_filter", {
      filter : $("#address-lookup-filter").val()
    });
  }

  var $table = $("#address-lookup-table");
  $table.trigger("footable_initialize");
  $table.data("footable-filter").clearFilter();
  $("#address-lookup-table > tbody tr").selection().on("dblclick", function() {
    var values = pair.split(",");
    $("#" + values[0]).val($(this).attr("id").trim()).change();
    if (void 0 !== values[1]) {
      $("#" + values[1]).val($(this).attr("lbl").trim()).text($(this).attr("lbl").trim()).change();
    }
    $("#address-lookup-modal").modal("hide");
  });
  $("#address-lookup-address-filter").on("input", function() {
    if ("" == $("#lookup-address-filter").val()) {
      $table.data("footable-filter").clearFilter();
    }
    clear();
  });
  $("#address-lookup-address-type").change(function() {
    if ("" == $("#address-lookup-address-type").val()) {
      $table.data("footable-filter").clearFilter();
    }
    clear();
  });
  if (coords) {
    $("#address-lookup-address-type").val(coords);
    clear();
  }
  if (dataAndEvents) {
    $("tr.addressTypeS", $table).hide();
  }
  else {
    $("tr.addressTypeR", $table).hide();
  }
}
function transactionPageInit() {
  var r20 = [{
    name : "Copy&nbsp;Amount",
    fun : function() {
      copy("#transactions .footable .selected .amount", "data-value");
    }
  }, {
    name : "Copy&nbsp;transaction&nbsp;ID",
    fun: function () {
      var trxId = $("#transactions .footable .selected").attr("id");
      copy(trxId.substring(0, trxId.length-4), "copy");
    }
  }, {
    name : "Edit&nbsp;label",
    fun : function() {
      $("#transactions .footable .selected .editable").dblclick();
    }
  }, {
    name : "Show&nbsp;transaction&nbsp;details",
    fun : function() {
      $("#transactions .footable .selected").dblclick();
    }
  }];
  $("#transactions .footable tbody").on("contextmenu", function(ev) {
    $(ev.target).closest("tr").click();
  }).contextMenu(r20, {
    triggerOn : "contextmenu",
    sizeStyle : "content"
  });
  $("#transactions .footable").on("footable_paging", function(data) {
    var self = filteredTransactions.slice(data.page * data.size);
    self = self.slice(0, data.size);
    var doc = $("#transactions .footable tbody");
    doc.html("");
    delete data.ft.pageInfo.pages[data.page];
    data.ft.pageInfo.pages[data.page] = self.map(function(result) {
      var id = (Array.isArray(result)) ? result[0].id : result.id;
      return result.html = formatTransaction(result), doc.append(result.html), $("#" + id)[0];
    });
    data.result = true;
    bindTransactionTableEvents();
  }).on("footable_create_pages", function(e) {
    var $table = $("#transactions .footable");
    if (!$($table.data("filter")).val()) {
      filteredTransactions = Transactions;
    }
    var i = $table.data("sorted");
    var err = 1 == $table.find("th.footable-sorted").length;
    var callback = "numeric";
    switch(i) {
      case 1:
        i = "d";
        break;
      case 2:
        i = "t_l";
        callback = "alpha";
        break;
      case 3:
        i = "ad";
        callback = "alpha";
        break;
      case 4:
        i = "n";
        callback = "alpha";
        break;
      case 5:
        i = "am";
        break;
      default:
        i = "c";
    }
    callback = e.ft.options.sorters[callback];
    filteredTransactions.sort(function(a, b) {
      var txA = (Array.isArray(a)) ? a[0] : a;
      var txB = (Array.isArray(b)) ? b[0] : b;
      return err ? callback(txA[i], txB[i]) : callback(txB[i], txA[i]);
    });
    delete e.ft.pageInfo.pages;
    e.ft.pageInfo.pages = [];
    var numRounds = Math.ceil(filteredTransactions.length / e.ft.pageInfo.pageSize);
    var copies = [];
    if (numRounds > 0) {
      var t = 0;
      for (;t < e.ft.pageInfo.pageSize;t++) {
        copies.push([]);
      }
      t = 0;
      for (;t < numRounds;t++) {
        e.ft.pageInfo.pages.push(copies);
      }
    }
  }).on("footable_filtering", function(options) {
    if (!!options.clear) {
      return;
    }
    filteredTransactions = [];
    Transactions.forEach(function(tx) {
      if (Array.isArray(tx)) {
        var filteredTransactionArray = tx.filter(function(e) {
          return filterTransaction(e, options.filter);
        });
        if (filteredTransactionArray.length === 1) {
          filteredTransactions.push(filteredTransactionArray[0]);
        }
        else if (filteredTransactionArray.length > 0) {
          filteredTransactions.push(filteredTransactionArray);
        }
      }
      else if (filterTransaction(tx, options.filter)) {
        filteredTransactions.push(tx);
      }
    });
  });
}
function filterTransaction(tx, filter) {
  var i;
  for (i in tx) {
    if (tx[i].toString().toLowerCase().indexOf(filter.toLowerCase()) !== -1) {
      return true;
    }
  }
  return false;
}
function formatTransaction(tx) {
  if (Array.isArray(tx)) {
    var tooltipStatus = tx[0].tt;
    if (tx.length > 1 && tx[0].tt !== tx[tx.length-1].tt) {
      tooltipStatus = "Tx.No. 1:\n" + tooltipStatus;
      tooltipStatus += "\n-\n" + "Tx.No. " + tx.length + ":\n" + tx[tx.length-1].tt;
    }
    var totalAmount = 0;
    var narrCons = "";
    var addresses = new Set();
    tx.forEach(function(txElement) {
      addresses.add(txElement.ad_d.trim());
      if (txElement.n) {
        if (narrCons) {
          narrCons += "; "
        }
        narrCons += txElement.n.trim();
      }
      totalAmount += txElement.am;
    });
    var addrCons = "";
    addresses.forEach(function(a) {
      if (addrCons) {
        addrCons += "; "
      }
      addrCons += a;
    });

        var o = tx[0];
        return "<tr id='" + o.id + "'"+ ((tx.length === 1) ? " data-title='" + o.tt + "'" : "") + ">"+
            "<td class='trans-status' data-value='" + o.c + "'" + ((tx.length > 1) ? " data-title='" + tooltipStatus + "'" : "") + "><i class='fa fa-2x " + o.s + "'></td>"+
            "<td class='trans-date' data-value='" + o.d + "'" + ((tx.length > 1) ? " data-title='" + tx[0].d_s + " - "+ tx[tx.length-1].d_s + "'" : "") + ">" + o.d_s + "</td>"+
            "<td class='amount' style='color:" + o.am_c + ";' data-value='" + unit.format(totalAmount) + "'>" + unit.format(totalAmount) + " " + unit.display + "</td>"+
            "<td class='trans-type-icon'" + ((tx.length > 1) ? " data-title='" + tooltipStatus + "'" : "") + "><img width='100%' src='assets/svg/tx_" + o.t + ".svg' /></td>"+
            "<td class='trans-type'" + ((tx.length > 1) ? " data-title='" + tooltipStatus + "'" : "") + ">" + o.t_l + " <b>&nbsp;(x" + tx.length + ")</b></td>"+
            "<td class='address' style='color:" + o.a_c + ";' data-value='" + addrCons + "' data-label='" + addrCons + "' data-title='" + addrCons + "' ><span>" + ((addrCons.length > 26) ? (addrCons.substr(0, 26) + "...") : addrCons) + "</span></td>"+
            "<td class='trans-nar' data-title='" + narrCons + "'>" + narrCons + "</td>" +
            "</tr>";
    }
    else {
        var o = tx;
        return "<tr id='" + o.id + "'>"+
            "<td class='trans-status' data-value='" + o.c + "' data-title='" + o.tt + "'><i class='fa fa-2x " + o.s + "'></td>"+
            "<td class='trans-date' data-value='" + o.d + "'>" + o.d_s + "</td>"+
            "<td class='amount' style='color:" + o.am_c + ";' data-value='" + o.am_d + "'>" + o.am_d + " " + unit.display + "</td>"+
            "<td class='trans-type-icon'><img width='100%' src='assets/svg/tx_" + o.t + ".svg' /></td>"+
            "<td class='trans-type'><span>" + o.t_l + "</span></td>"+
            "<td class='address' style='color:" + o.a_c + ";' data-value='" + o.ad + "' data-label='" + o.ad_l + "'><span "+ ( o.ad ? "class='editable'" : "") +">" + ((o.ad_d.length > 26) ? (o.ad_d.substr(0, 26) + "...") : o.ad_d) + "</span></td>"+
            "<td class='trans-nar'>" + o.n + "</td>" +
            "</tr>";
    }
}
function visibleTransactions(checkSet) {
  if ("*" !== checkSet[0]) {
    RawTransactions = RawTransactions.filter(function(dataAndEvents) {
      return this.some(function(dataAndEvents) {
        return dataAndEvents == this;
      }, dataAndEvents.t_l);
    }, checkSet);
    prepareTransactions();
  }
}
function bindTransactionTableEvents() {
  $("#transactions .footable tbody td[data-title]").tooltip();
  $("#transactions .footable tbody tr[data-title]").tooltip();
  $("#transactions .footable tbody tr").on("click", function() {
    $(this).addClass("selected").siblings("tr").removeClass("selected");
  }).on("dblclick", function(dataAndEvents) {
    $(this).attr("href", "#transaction-info-modal");
    $("#transaction-info-modal").appendTo("body").modal("show");
    bridge.transactionDetails($(this).attr("id"));
    $(this).click();
    $(this).off("click");
    $(this).on("click", function() {
      $(this).addClass("selected").siblings("tr").removeClass("selected");
    });
  }).find(".editable").on("dblclick", function(event) {
    event.stopPropagation();
    event.preventDefault();
    updateValue($(this));
  }).attr("data-title", "Double click to edit").tooltip();
}
function appendTransactions(f, reset) {
  console.log(f);
  if ("string" == typeof f) {
    if ("[]" == f && !reset) {
      return;
    }
    f = JSON.parse(f.replace(/,\]$/, "]"));
  }
  f.sort(function(a, b) {
    return a.d = parseInt(a.d), b.d = parseInt(b.d), b.d - a.d;
  });
  if (reset) {
    RawTransactions = f;
  }
  else if (!(1 == f.length && f[0].id == -1)) {
    RawTransactions = RawTransactions.filter(function(deepDataAndEvents) {
      return 0 == this.some(function(finger) {
        return finger.id == this.id;
      }, deepDataAndEvents);
    }, f).concat(f);
  }
  overviewPage.recent(f.slice(0, 7));
  prepareTransactions();
}

function prepareTransactions() {
  var optGroupTxType = $('select[id=optGroupTxType]').val()
  var optGroupTxTime = $('select[id=optGroupTxTime]').val()
  if (optGroupTxTime === "0") {
    Transactions = RawTransactions;
  }
  else {
    var groups = { };
    Transactions = [];
    RawTransactions.forEach(function(tx){
      if (optGroupTxType === "0" && (tx.t_i < 1 || tx.t_i > 6)) {
        Transactions.push(tx);
      }
      else {
        var txDate = new Date(tx.d * 1000);

        // Generated = 1 / GeneratedDonation = 3 / GeneratedContribution = 5
        // GeneratedSPECTRE = 2 / GeneratedSPECTREDonation = 4 / GeneratedSPECTREContribution = 6
        var txType = (tx.s_i !== 9) ? tx.t_i : (tx.t_i === 3 || tx.t_i === 5) ? 1 : (tx.t_i === 4 || tx.t_i === 6) ? 2 : tx.t_i;
        var key = txType + "-" + tx.s_i;
        switch (optGroupTxTime) {
          case "1":
            key = txDate.getDate() + "-" + key;
          case "2":
            key = txDate.getMonth() + "-" + key;
          case "3":
            key = txDate.getFullYear() + "-" + key;
        }
        var list = groups[key];
        if(list) {
          list.push(tx);
        } else {
          groups[key] = [tx];
          Transactions.push(groups[key]);
        }
      }
    });
  }
  $("#transactions .footable").trigger("footable_redraw");
}

function getIconTitle(value) {
  return "unverified" == value ? "fa fa-cross " : "verified" == value ? "fa fa-check " : "contributor" == value ? "fa fa-cog " : "spectreteam" == value ? "fa fa-code " : "";
}

function signMessage() {
  $("#sign-signature").val("");
  var message;
  var callback;
  var msg;
  var length = "";
  message = $("#sign-address").val().trim();
  callback = $("#sign-message").val().trim();
    //TODO: SIGNAL bridge
  var result = bridge.signMessage(message, callback);
  return msg = result.error_msg, length = result.signed_signature, "" !== msg ? ($("#sign-result").removeClass("green"), $("#sign-result").addClass("red"), $("#sign-result").html(msg), false) : ($("#sign-signature").val(result.signed_signature), $("#sign-result").removeClass("red"), $("#sign-result").addClass("green"), $("#sign-result").html("Message signed successfully"), void 0);
}
function verifyMessage() {
  var message;
  var callback;
  var msg;
  var partials = "";
  message = $("#verify-address").val().trim();
  callback = $("#verify-message").val().trim();
  partials = $("#verify-signature").val().trim();
    //TODO: SIGNAL bridge
  var result = bridge.verifyMessage(message, callback, partials);
  return msg = result.error_msg, "" !== msg ? ($("#verify-result").removeClass("green"), $("#verify-result").addClass("red"), $("#verify-result").html(msg), false) : ($("#verify-result").removeClass("red"), $("#verify-result").addClass("green"), $("#verify-result").html("Message verified successfully"), void 0);
}
function iscrollReload(dataAndEvents) {
  messagesScroller.refresh();
  if (dataAndEvents === true) {
    messagesScroller.scrollTo(0, messagesScroller.maxScrollY, 0);
  }
}
function editorCommand(text, subs) {
  var startPos;
  var end;
  var _len;
  var y;
  var that = $("#message-text")[0];
  y = that.scrollTop;
  that.focus();
  if ("undefined" != typeof that.selectionStart) {
    startPos = that.selectionStart;
    end = that.selectionEnd;
    _len = text.length;
    if (subs) {
      text += that.value.substring(startPos, end) + subs;
    }
    that.value = that.value.substring(0, startPos) + text + that.value.substring(end, that.value.length);
    that.selectionStart = startPos + text.length - (subs ? subs.length : 0);
    that.selectionEnd = that.selectionStart;
  } else {
    that.value += text + subs;
  }
  that.scrollTop = y;
  that.focus();
}
function setupWizard(vid) {
  var collection = $("#" + vid + " > div");
  backbtnjs = '$("#key-options").show(); $("#wizards").hide();';
  fwdbtnjs = 'gotoWizard("new-key-wizard", 1);';
  $("#" + vid).prepend("<div id='backWiz' style='display:none;' class='btn btn-default btn-cons wizardback' onclick='" + backbtnjs + "' >Back</div>");
  $("#" + vid).prepend("<div id='fwdWiz'  style='display:none;' class='btn btn-default btn-cons wizardfwd'  onclick='" + fwdbtnjs + "' >Next Step</div>");
  collection.each(function(i) {
    $(this).addClass("step" + i);
    $(this).hide();
    $("#backWiz").hide();
  });
}
function gotoWizard(vid, node, dataAndEvents) {
  var collection = $("#wizards > div");
  if (validateJS = $("#" + vid + " .step" + (node - 1)).attr("validateJS"), dataAndEvents && void 0 !== validateJS) {
    var jsonObj = eval(validateJS);
    if (!jsonObj) {
      return false;
    }
  }
  collection.each(function(dataAndEvents) {
    $(this).hide();
  });
  var $allModules = $("#" + vid + " > div[class^=step]");
  var current = node;
  if (null == current) {
    current = 0;
  }
  if (0 == current) {
    $("#" + vid + " #backWiz").attr("onclick", '$(".wizardback").hide(); $("#wizards").show();');
    $("#" + vid + " #fwdWiz").attr("onclick", '$(".wizardback").hide(); gotoWizard("' + vid + '", 1, true);');
    $("#backWiz").hide();
  } else {
    $("#" + vid + " #backWiz").attr("onclick", 'gotoWizard("' + vid + '", ' + (current - 1) + " , false);");
    $("#" + vid + " #fwdWiz").attr("onclick", 'gotoWizard("' + vid + '", ' + (current + 1) + " , true);");
  }
  endWiz = $("#" + vid + " .step" + node).attr("endWiz");
  if (void 0 !== endWiz) {
    if ("" !== endWiz) {
      $("#" + vid + " #fwdWiz").attr("onclick", endWiz);
    }
  }
  $allModules.each(function(dataAndEvents) {
    $(this).hide();
  });
  $("#" + vid).show();
  stepJS = $("#" + vid + " .step" + current).attr("stepJS");
  if (dataAndEvents) {
    if (void 0 !== stepJS) {
      eval(stepJS);
    }
  }
  $("#" + vid + " .step" + current).fadeIn(0);
}
function dumpStrings() {
  function clone(dataAndEvents) {
    return'QT_TRANSLATE_NOOP("SpectreBridge", "' + dataAndEvents + '"),\n';
  }
  var data = "";
  $(".translate").each(function(dataAndEvents) {
    var d = clone($(this).text().trim());
    if (data.indexOf(d) == -1) {
      data += d;
    }
  });
  $("[data-title]").each(function(dataAndEvents) {
    var d = clone($(this).attr("data-title").trim());
    if (data.indexOf(d) == -1) {
      data += d;
    }
  });
  console.log(data);
}
//TODO: Update the translation function in a way that support QtWebEngine, QtWebEngine does not support calling a function that return results immediatly, it have to be done in a non blocking way using signals and slots
function translateStrings() {
//  $(".translate").each(function(dataAndEvents) {
//    var template = $(this).text();
//      console.log("template is " + template)
//      console.log("Translated template is " + bridge.translateHtmlString(template.trim()))
//    $(this).text(template.replace(template, bridge.translateHtmlString(template.trim())));
//  });
//  $("[data-title]").each(function(dataAndEvents) {
//    var title = $(this).attr("data-title");
//      console.log("Title is " + title)
//      console.log("Translated title is " + bridge.translateHtmlString(title.trim()))

//    $(this).attr("data-title", title.replace(title, bridge.translateHtmlString(title.trim())));
//  });
}
var breakpoint = 906;
var base58 = {
  base58Chars : "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz",
  check : function(target) {
    var el = $(target);
    var values = el.val();
    var i = 0;
    var valuesLen = values.length;
    for (;i < valuesLen;++i) {
      if (base58.base58Chars.indexOf(values[i]) == -1) {
        return el.css("background", "#1c5ce5").css("color", "white"), false;
      }
    }
    return el.css("background", "").css("color", ""), true;
  }
};
var pasteTo = "";
var unit = {
  type : 0,
  name : "ALIAS",
  display : "ALIAS",
  setType : function(v) {
    switch(this.type = void 0 == v ? 0 : v, v) {
      case 1:
        this.name = "mALIAS";
        this.display = "mALIAS";
        break;
      case 2:
        this.name = "uALIAS";
        this.display = "&micro;ALIAS";
        break;
      case 3:
        this.name = "satALIAS";
        this.display = "satALIAS";
        break;
      default:
        this.name = "ALIAS";
        this.display = "ALIAS";
    }
    $("td.unit,span.unit,div.unit").html(this.display);
    $("select.unit").val(v).trigger("change");
    $("input.unit").val(this.name);
    
    overviewPage.updateBalance();
  },
  format : function(value, arg, stripTrailingZeros) {
    var results = $.isNumeric(value) ? null : $(value);
    switch(arg = void 0 == arg ? this.type : parseInt(arg), value = parseInt(void 0 == results ? value : void 0 == results.data("value") ? results.val() : results.data("value")), arg) {
      case 1:
        value /= 1E5;
        break;
      case 2:
        value /= 100;
        break;
      case 3:
        break;
      default:
        value /= 1E8;
    }
    return value = stripTrailingZeros ? value.toString() : value.toFixed(this.mask(arg)), void 0 == results ? value : void results.val(value);
  },
  parse : function(value, text) {
    var results = $.isNumeric(value) ? null : $(value);
    text = void 0 == text ? this.type : parseInt(text);
    fp = void 0 == results ? value : results.val();
    if (void 0 == fp || fp.length < 1) {
      fp = ["0", "0"];
    } else {
      if ("." == fp[0]) {
        fp = ["0", fp.slice(1)];
      } else {
        fp = fp.split(".");
      }
    }
    value = parseInt(fp[0]);
    var n = this.mask(text);
    if (n > 0 && (value *= Math.pow(10, n)), n > 0 && fp.length > 1) {
      var bits = fp[1].split("");
      for (;bits.length > 1 && "0" == bits[bits.length - 1];) {
        bits.pop();
      }
      var increment = parseInt(bits.join(""));
      if (increment > 0) {
        n -= bits.length;
        if (n > 0) {
          increment *= Math.pow(10, n);
        }
        value += increment;
      }
    }
    return void 0 == results ? value : (results.data("value", value), void this.format(results, text));
  },
  mask : function(value) {
    switch(value = void 0 == value ? this.type : parseInt(value)) {
      case 1:
        return 5;
      case 2:
        return 2;
      case 3:
        return 0;
      default:
        return 8;
    }
  },
  keydown : function(e) {
    var key = e.which;
    var udataCur = $(e.target).siblings(".unit").val();
    if (190 == key || 110 == key) {
      return this.value.toString().indexOf(".") === -1 && 0 != unit.mask(udataCur) || e.preventDefault(), true;
    }
    if (e.shiftKey || !(key >= 96 && key <= 105 || key >= 48 && key <= 57)) {
      if (!(8 == key)) {
        if (!(9 == key)) {
          if (!(17 == key)) {
            if (!(46 == key)) {
              if (!(45 == key)) {
                if (!(key >= 35 && key <= 40)) {
                  if (!(e.ctrlKey && (65 == key || (67 == key || (86 == key || 88 == key))))) {
                    e.preventDefault();
                  }
                }
              }
            }
          }
        }
      }
    } else {
      var startPos = this.selectionStart;
      var endPos = this.value.indexOf(".");
      if ("Range" !== document.getSelection().type && (startPos > endPos && (this.value.indexOf(".") !== -1 && this.value.length - 1 - endPos >= unit.mask(udataCur)))) {
        if ("0" == this.value[this.value.length - 1] && startPos < this.value.length) {
          return this.value = this.value.slice(0, -1), this.selectionStart = startPos, void(this.selectionEnd = startPos);
        }
        e.preventDefault();
      }
    }
  },
  paste : function(e) {
    var subStr = e.originalEvent.clipboardData.getData("text/plain");
    if (!$.isNumeric(subStr) || this.value.indexOf(".") !== -1 && "Range" !== document.getSelection().type) {
      e.preventDefault();
    }
  }
};
var contextMenus = [];
var overviewPage = {
  init : function() {
    this.balance = $(".balance");
    this.spectreBal = $(".spectre_balance");
    this.reserved = $("#reserved");
    this.reservedSpectre = $("#reserved_spectre");
    this.stake = $("#stake");
    this.spectreStake = $("#spectre_stake");
    this.unconfirmed = $("#unconfirmed");
    this.spectreUnconfirmed = $("#spectre_unconfirmed");
    this.immature = $("#immature");
    this.spectreImmature = $("#spectre_immature");
    this.total = $("#total");
  },
  updateBalance : function(balanceVal, spectreBalVal, stakeVal, spectreStakeVal, unconfirmedVal, spectreUnconfirmedVal, immatureVal, spectreImmatureVal) {
    if (void 0 == balanceVal) {
      balanceVal = this.balance.data("orig");
      spectreBalVal = this.spectreBal.data("orig");
      stakeVal = this.stake.data("orig");
      spectreStakeVal = this.spectreStake.data("orig");
      unconfirmedVal = this.unconfirmed.data("orig");
      spectreUnconfirmedVal = this.spectreUnconfirmed.data("orig");
      immatureVal = this.immature.data("orig");
      spectreImmatureVal = this.spectreImmature.data("orig");
    } else {
      this.balance.data("orig", balanceVal);
      this.spectreBal.data("orig", spectreBalVal);
      this.stake.data("orig", stakeVal);
      this.spectreStake.data("orig", spectreStakeVal);
      this.unconfirmed.data("orig", unconfirmedVal);
      this.spectreUnconfirmed.data("orig", unconfirmedVal);
      this.immature.data("orig", immatureVal);
      this.spectreImmature.data("orig", spectreImmatureVal);
    }
    this.formatValue("balance", "spectreBal", balanceVal, spectreBalVal, true);
    this.formatValue("stake", "spectreStake", stakeVal, spectreStakeVal);
    this.formatValue("unconfirmed", "spectreUnconfirmed", unconfirmedVal, spectreUnconfirmedVal);
    this.formatValue("immature", "spectreImmature", immatureVal, spectreImmatureVal);
    this.formatTotalValue(balanceVal + spectreBalVal + stakeVal + spectreStakeVal + unconfirmedVal + spectreUnconfirmedVal + immatureVal + spectreImmatureVal);
  },
  updateReserved : function(value) {
    this.formatValue("reserved", "reservedSpectre", value, value);
  },
  formatTotalValue : function(value) {
    var data = ["0","0"];
    if (void 0 !== value && !isNaN(value)) {
      data = unit.format(value).split(".");
    }
    $("#total-big > span:first-child").text(data[0]);
    if (unit.type == 3) {
      $("#total-big .light-red").toggle(false);
      $("#total-big .cents").toggle(false);
    }
    else {
      $("#total-big .cents").text(data[1]);
      $("#total-big .light-red").toggle(true);
      $("#total-big .cents").toggle(true);
    }
  },
  formatValue : function(target1, target2, value1, value2, showZero) {
    var target1HTML = this[target1];
    var target2HTML = this[target2];

    if (0 !== value1 || showZero) {
      target1HTML.text(unit.format(value1));
    } else {
      target1HTML.html("");
    }
    if (0 !== value2 || showZero) {
      target2HTML.text(unit.format(value2));
    } else {
      target2HTML.html("");
    }
    if (!showZero && 0 === value1 && 0 === value2) {
      target1HTML.parent("tr").hide();
    } else {
      target1HTML.parent("tr").show();
    }
  },
  recent : function(codeSegments) {
    var i = 0;
    for (;i < codeSegments.length;i++) {
      overviewPage.updateTransaction(codeSegments[i]);
    }
    $("#recenttxns [data-title]").tooltip();
  },
  updateTransaction : function(message) {
    var update = function(data) {
      var label = (8 === data.s_i || 9 === data.s_i) ? "Orphan" :
          "input" == data.t ? "Received" : "output" == data.t ? "Sent" : "inout" == data.t ? "In-Out" : "staked" == data.t ? "Stake" : "donated" == data.t ? "Donated" : "contributed" == data.t ? "Contributed" : "other" == data.t ? "Other" : data.t;
      return "<tr><td width='30%' style='border-top: 1px solid rgba(230, 230, 230, 0.7);border-bottom: none;' data-title='" + data.tt + "'>" +
          "<label style='margin-top:6px;' class='label label-important inline fs-12'>" + label + "</label></td>" +
          "<td style='border-top: 1px solid rgba(230, 230, 230, 0.7);border-bottom: none;'><a id='" + data.id.substring(data.id.length - 20) + "' href='#' onclick='$(\"#navitems [href=#transactions]\").click();$(\"#" + data.id + " > td.amount\").click();'> " +
          unit.format(data.am, 0, true) + " <span class='unit'>" + unit.display + " (" + ((data.am_curr === 'PRIVATE') ? "private" : "public") + ")</span></a></td>" +
          "<td width='30%' style='border-top: 1px solid rgba(230, 230, 230, 0.7);border-bottom: none;'><span class='overview_date' data-value='" + data.d + "'>" + data.d_s + "</span></td></tr>";
    };
    var row = update(message);
    var idfirst = message.id.substring(message.id.length-20);
    var existingRow = $("#" + idfirst).attr("data-title", message.tt).closest("tr");
    if (0 == existingRow.length) {
      var $items = $("#recenttxns tr");
      var o = false;
      var i = 0;
      for (;i < $items.length;i++) {
        var $this = $($items[i]);
        if (parseInt(message.d) > parseInt($this.find(".overview_date").data("value"))) {
          $this.before(row);
          o = true;
          break;
        }
      }
      if (!o) {
        $("#recenttxns").append(row);
      }
      $items = $("#recenttxns tr");
      for (;$items.length > 8;) {
        $("#recenttxns tr:last").remove();
        $items = $("#recenttxns tr");
      }
    }
    else {
      existingRow.replaceWith(row);
    }
  },
  clientInfo : function() {
    $("#version").text(bridge.info.build.replace(/\-[\w\d]*$/, ""));
    $("#clientinfo").attr("data-title", "Build Desc: " + bridge.info.build + "\nBuild Date: " + bridge.info.date).tooltip();
  },
  encryptionStatusChanged : function(status) {
    switch(status) {
      case 0:
        ;
      case 1:
        ;
      case 2:
        ;
    }
  }
};
var optionsPage = {
  init : function() {
  },
  connectSignals : function() {
    bridge.getOptionResult.connect(this.getOptionResult);
  },
  getOptionResult : function (result) {
    function update($el) {
      $el = $(this);
      var val = $el.prop("checked");
      var codeSegments = $el.data("linked");
      if (codeSegments) {
        codeSegments = codeSegments.split(" ");
        var i = 0;
        for (;i < codeSegments.length;i++) {
          var $wrapper = $("#" + codeSegments[i] + ",[for=" + codeSegments[i] + "]").attr("disabled", !val);
          if (val) {
            $wrapper.removeClass("disabled");
          } else {
            $wrapper.addClass("disabled");
          }
        }
      }
    }
    bridge.info.options = result;
    var list = result;
    console.log('result');
    console.log(result);
    $("#options-ok,#options-apply").addClass("disabled");
    var name;
    for (name in list) {
      var el = $("#opt" + name);
      var value = list[name];
      var data = list["opt" + name];
      if (0 != el.length) {
        if (data) {
          el.html("");
          var type;
          for (type in data) {
            if ("string" == typeof type && ($.isArray(data[type]) && !$.isNumeric(type))) {
              el.append("<optgroup label='" + type[0].toUpperCase() + type.slice(1) + "'>");
              var x = 0;
              for (;x < data[type].length;x++) {
                el.append("<option>" + data[type][x] + "</option>");
              }
            } else {
              el.append("<option" + ($.isNumeric(type) ? "" : " value='" + type + "'") + ">" + data[type] + "</option>");
            }
          }
        }
        if (el.is(":checkbox")) {
          el.prop("checked", value === true || "true" === value);
          el.off("change");
          el.on("change", update);
          el.change();
        } else {
          if (el.is("select[multiple]") && ("*" === value || (Array.isArray(value) && value.length > 0 && value[0] === "*"))) {
            el.find("option").attr("selected", true);
          } else {
            if (el.hasClass('amount')) {
              el.data('value', value);
              value = unit.format(value, 0); // convert amount from satoshis (note: assumes unit is always 0)
            }
            el.val(value);
          }
        }
        el.one("change", function() {
          $("#options-ok,#options-apply").removeClass("disabled");
        });
      } else {
        if (name.indexOf("opt") == -1) {
          console.log("Option element not available for %s", name);
        }
      }
    }
  },
  update : function() {
    bridge.getOptions();
  },
  save : function() {
    var o = bridge.info.options;
    var cache = {};
    var prop;
    for (prop in o) {
      var $field = $("#opt" + prop);
      var n = o[prop];
      var value = false;
      if (!(null != n && "false" != n)) {
        n = false;
      }
      if (0 != $field.length) {
        if ($field.is(":checkbox")) {
          value = $field.prop("checked");
        } else {
          if ($field.is("select[multiple]")) {
            value = $field.val();
            if (null === value) {
              value = "*";
            }
          } else {
            value = $field.val();
            if ($field.hasClass('amount')) {
              // convert amount to satoshis (note: assumes unit is always 0)
              value = unit.parse(value, 0);
            }
          }
        }
        if (n != value) {
          if (n.toString() !== value.toString()) {
            cache[prop] = value;
          }
        }
      }
    }
    if (!$.isEmptyObject(cache)) {
      console.log("calling bridge.userAction.optionsChanged")
      bridge.userAction({
        optionsChanged : cache
      });
      optionsPage.update();
      if (cache.hasOwnProperty("AutoRingSize")) {
        changeTxnType();
      }
    } else {
      console.log("options cache is empty")
    }
  }
};
var RawTransactions = [];
var Transactions = [];
var filteredTransactions = [];
var current_key = "";

var chainDataPage = {
  anonOutputs : {},
  connectSignals: function() {
    console.log("chainDataPage.connectSignals");
    bridge.listAnonOutputsResult.connect(this.listAnonOutputsResult);
  },
  init : function() {
    $("#show-own-outputs,#show-all-outputs").on("click", function(ev) {
      $(ev.target).hide().siblings("a").show();
    });
    $("#show-own-outputs").on("click", function() {
      $("#chaindata .footable tbody tr>td:first-child+td").each(function() {
        if (0 == $(this).text()) {
          $(this).parents("tr").hide();
        }
      });
    });
    $("#show-all-outputs").on("click", function() {
      $("#chaindata .footable tbody tr:hidden").show();
    });
  },
  updateAnonOutputs : function() {
    bridge.listAnonOutputs();
  },
  /*Available fields in anonOutputs:
  owned_mature
  owned_outputs
  system_mature
  system_compromised
  system_outputs
  system_spends
  system_unspent
  system_unspent_mature
  system_mixins
  system_mixins_mature
  system_mixins_staking */
  listAnonOutputsResult : function(result) {
    chainDataPage.anonOutputs = result;
    var tagList = $("#chaindata .footable tbody");
    tagList.html("");
    for (value in chainDataPage.anonOutputs) {
      var state = chainDataPage.anonOutputs[value];
      tagList.append("<tr>  <td data-toggle=true></td>                  <td data-value=" + value + ">" + state.value_s + "</td>                    <td>"
          + state.owned_outputs + (state.owned_outputs == state.owned_mature ? "" : " (<b>" + (state.owned_outputs - state.owned_mature) + "</b>)") + "</td>                    <td>"
          + state.system_unspent + (state.system_unspent == state.system_unspent_mature ? "" : " (<b>" + (state.system_unspent - state.system_unspent_mature)+ "</b>)") + "</td>                    <td>"
          + state.system_mixins + (state.system_mixins == state.system_mixins_mature ? "" : " (<b>" + (state.system_mixins - state.system_mixins_mature)+ "</b>)") + "</td>                    <td>"
          + state.system_outputs + (state.system_compromised == 0 ? "" : " (<b>" + state.system_compromised + "</b>)") + "</td>                    <td>"
          + state.least_depth + "</td>                </tr>");
    }
    $("#chaindata .footable").trigger("footable_initialize");
  }
};
var blockExplorerPage = {
  blockHeader : {},

  connectSignals: function() {
    console.log("blockExplorerPage.connectSignals");
    bridge.findBlockResult.connect(this.findBlockResult);
    bridge.listLatestBlocksResult.connect(this.listLatestBlocksResult);
    bridge.listTransactionsForBlockResult.connect(this.listTransactionsForBlockResult);
    bridge.txnDetailsResult.connect(this.txnDetailsResult);
    bridge.blockDetailsResult.connect(this.blockDetailsResult);
  },

  findBlock : function(value) {
    console.log("findBlock : function(value)");
    console.log(value);

    if ("" === value || null === value) {
      blockExplorerPage.updateLatestBlocks();
    } else {
      bridge.findBlock(value);
      //will callback findBlockResult
    }
  },

  findBlockResult : function(result) {
    console.log("findBlockResult : function(result)");
    blockExplorerPage.foundBlock = result;
    if (blockExplorerPage.foundBlock, "" !== blockExplorerPage.foundBlock.error_msg) {
      return $("#latest-blocks-table  > tbody").html(""), $("#block-txs-table > tbody").html(""), $("#block-txs-table").addClass("none"), alert(blockExplorerPage.foundBlock.error_msg), false;
    }
    var tagList = $("#latest-blocks-table  > tbody");
    tagList.html("");
    var $title = $("#block-txs-table  > tbody");
    $title.html("");
    $("#block-txs-table").addClass("none");
    tagList.append("<tr data-value=" + blockExplorerPage.foundBlock.block_hash + ">                                     <td>" + blockExplorerPage.foundBlock.block_hash + "</td>                                     <td>" + blockExplorerPage.foundBlock.block_height + "</td>                                     <td>" + blockExplorerPage.foundBlock.block_timestamp + "</td>                                     <td>" + blockExplorerPage.foundBlock.block_transactions + "</td>                        </tr>");
    blockExplorerPage.prepareBlockTable();
  },

  updateLatestBlocks : function() {
    blockExplorerPage.latestBlocks = bridge.listLatestBlocks();
  },

  listLatestBlocksResult : function(result) {
    console.log("function listLatestBlocksResult")
    console.log(result)
    blockExplorerPage.latestBlocks = result;
    var $title = $("#block-txs-table  > tbody");
    $title.html("");
    $("#block-txs-table").addClass("none");
    var tagList = $("#latest-blocks-table  > tbody");
    tagList.html("");
    for (value in blockExplorerPage.latestBlocks) {
      var cachedObj = blockExplorerPage.latestBlocks[value];
      tagList.append("<tr data-value=" + cachedObj.block_hash + ">                         <td>" + cachedObj.block_hash + "</td>                         <td>" + cachedObj.block_height + "</td>                         <td>" + cachedObj.block_timestamp + "</td>                         <td>" + cachedObj.block_transactions + "</td>                         </tr>");
    }
    blockExplorerPage.prepareBlockTable();
  },

  prepareBlockTable : function() {
    $("#latest-blocks-table  > tbody tr").selection().on("click", function() {
      var r20 = $(this).attr("data-value").trim();
      blockExplorerPage.blkTxns = bridge.listTransactionsForBlock(r20);
    }).on("dblclick", function(dataAndEvents) {
      $("#block-info-modal").appendTo("body").modal("show");
      selectedBlock = bridge.blockDetails($(this).attr("data-value").trim());
    }).find(".editable");
  },

  listTransactionsForBlockResult : function(blkHash, result) {
    blockExplorerPage.blkTxns = result;
    var tagList = $("#block-txs-table  > tbody");
    tagList.html("");
    for (value in blockExplorerPage.blkTxns) {
      var cachedObj = blockExplorerPage.blkTxns[value];
      tagList.append("<tr data-value=" + cachedObj.transaction_hash + ">                                    <td>" + cachedObj.transaction_hash + "</td>                                    <td>" + cachedObj.transaction_value + "</td>                                    </tr>");
    }
    $("#block-txs-table").removeClass("none");
    $("#block-txs-table > tbody tr").selection().on("dblclick", function(dataAndEvents) {
      $("#blkexp-txn-modal").appendTo("body").modal("show");
      selectedTxn = bridge.txnDetails(blkHash, $(this).attr("data-value").trim());
    }).find(".editable");
  },

  txnDetailsResult : function(result) {
    selectedTxn = result;
    if ("" == selectedTxn.error_msg) {
      $("#txn-hash").html(selectedTxn.transaction_hash);
      $("#txn-size").html(selectedTxn.transaction_size);
      $("#txn-rcvtime").html(selectedTxn.transaction_rcv_time);
      $("#txn-minetime").html(selectedTxn.transaction_mined_time);
      $("#txn-blkhash").html(selectedTxn.transaction_block_hash);
      $("#txn-reward").html(selectedTxn.transaction_reward);
      $("#txn-confirmations").html(selectedTxn.transaction_confirmations);
      $("#txn-value").html(selectedTxn.transaction_value);
      $("#error-msg").html(selectedTxn.error_msg);
      if (selectedTxn.transaction_reward > 0) {
        $("#lbl-reward-or-fee").html("<strong>Reward</strong>");
        $("#txn-reward").html(selectedTxn.transaction_reward);
      } else {
        $("#lbl-reward-or-fee").html("<strong>Fee</strong>");
        $("#txn-reward").html(selectedTxn.transaction_reward * -1);
      }
    }
    var tagList = $("#txn-detail-inputs > tbody");
    tagList.html("");
    for (value in selectedTxn.transaction_inputs) {
      var cachedObj = selectedTxn.transaction_inputs[value];
      tagList.append("<tr data-value=" + cachedObj.input_source_address + ">                                                   <td>" + cachedObj.input_source_address + "</td>                                                   <td style='text-align:right'>" + cachedObj.input_value + "</td>                                                </tr>");
    }
    var $options = $("#txn-detail-outputs > tbody");
    $options.html("");
    for (value in selectedTxn.transaction_outputs) {
      var style = selectedTxn.transaction_outputs[value];
      $options.append("<tr data-value=" + style.output_source_address + ">                                                 <td>" + style.output_source_address + "</td>                                                 <td style='text-align:right'>" + style.output_value + "</td>                                            </tr>");
    }
  },

  blockDetailsResult : function(result) {
    selectedBlock = result;
    if (selectedBlock) {
      $("#blk-hash").html(selectedBlock.block_hash);
      $("#blk-numtx").html(selectedBlock.block_transactions);
      $("#blk-height").html(selectedBlock.block_height);
      $("#blk-type").html(selectedBlock.block_type);
      $("#blk-reward").html(selectedBlock.block_reward);
      $("#blk-timestamp").html(selectedBlock.block_timestamp);
      $("#blk-merkleroot").html(selectedBlock.block_merkle_root);
      $("#blk-prevblock").html(selectedBlock.block_prev_block);
      $("#blk-nextblock").html(selectedBlock.block_next_block);
      $("#blk-difficulty").html(selectedBlock.block_difficulty);
      $("#blk-bits").html(selectedBlock.block_bits);
      $("#blk-size").html(selectedBlock.block_size);
      $("#blk-version").html(selectedBlock.block_version);
      $("#blk-nonce").html(selectedBlock.block_nonce);
    }
    $(this).click().off("click").selection();
  }

};
var walletManagementPage = {

  connectSignals : function() {
    console.log("walletManagementPage.connectSignals");
    bridge.importFromMnemonicResult.connect(this.importFromMnemonicResult);
    bridge.getNewMnemonicResult.connect(this.getNewMnemonicResult);
    bridge.extKeyAccListResult.connect(this.extKeyAccListResult);
    bridge.extKeyListResult.connect(this.extKeyListResult);
//        bridge.extKeyImportResult.connect(this.extKeyImportResult);
    bridge.extKeySetDefaultResult.connect(this.extKeySetDefaultResult);
    bridge.extKeySetMasterResult.connect(this.extKeySetMasterResult);
    bridge.extKeySetActiveResult.connect(this.extKeySetActiveResult);
  },

  init : function() {
    setupWizard("new-key-wizard");
    setupWizard("recover-key-wizard");
    setupWizard("open-key-wizard");
  },
  newMnemonic : function() {
    bridge.getNewMnemonic($("#new-account-passphrase").val(), $("#new-account-language").val());
  },
  getNewMnemonicResult : function(result) {
    var c = result;
    var g = c.error_msg;
    var i = c.mnemonic;
    if ("" !== g) {
      alert(g);
    } else {
      $("#new-key-mnemonic").val(i);
    }
  },
  compareMnemonics : function() {
    var i = $("#new-key-mnemonic").val().trim();
    var last = $("#validate-key-mnemonic").val().trim();
    return i == last ? ($("#validate-key-mnemonic").removeClass("red"), $("#validate-key-mnemonic").val(""), true) : ($("#validate-key-mnemonic").addClass("red"), alert("The recovery phrase you provided does not match the recovery phrase that was generated earlier - please go back and check to make sure you have copied it down correctly."), false);
  },
  gotoPage : function(page) {
    $("#navitems a[href='#" + page + "']").trigger("click");
  },
  prepareAccountTable : function() {
    $("#extkey-account-table  > tbody tr").selection().on("click", function() {
      var $this = $("#extkey-table > tbody > tr");
      $this.removeClass("selected");
    });
  },
  updateAccountList : function() {
    bridge.extKeyAccList();
  },
  extKeyAccListResult : function(result) {
    walletManagementPage.accountList = result;
    var tagList = $("#extkey-account-table  > tbody");
    tagList.html("");
    for (value in walletManagementPage.accountList) {
      var result = walletManagementPage.accountList[value];
      tagList.append("<tr data-value=" + result.id + " active-flag=" + result.active + ">                         <td>" + result.id + "</td>                         <td>" + result.label + "</td>                         <td>" + result.created_at + '</td>                         <td class="center-margin"><i style="font-size: 1.2em; margin: auto;" ' + ("true" == result.active ? 'class="fa fa-circle green-circle"' : 'class="fa fa-circle red-circle"') + ' ></i></td>                         <td style="font-size: 1em; margin-bottom: 6px;">' +
          (void 0 !== result.default_account ? "<i class='center fa fa-check'></i>" : "") + "</td>                         </tr>");
    }
    walletManagementPage.prepareAccountTable();
  },
  prepareKeyTable : function() {
    $("#extkey-table  > tbody tr").selection().on("click", function() {
      var $this = $("#extkey-account-table > tbody > tr");
      $this.removeClass("selected");
    });
  },
  updateKeyList : function() {
    bridge.extKeyList();
  },
  extKeyListResult : function(result) {
    walletManagementPage.keyList = result;
    var tagList = $("#extkey-table  > tbody");
    tagList.html("");
    for (value in walletManagementPage.keyList) {
      var node = walletManagementPage.keyList[value];
      tagList.append("<tr data-value=" + node.id + " active-flag=" + node.active + ">                         <td>" + node.id + "</td>                         <td>" + node.label + "</td>                         <td>" + node.path + '</td>                         <td><i style="font-size: 1.2em; margin: auto;" ' + ("true" == node.active ? 'class="fa fa-circle green-circle"' : 'class="fa fa-circle red-circle"') + ' ></i></td>                         <td style="font-size: 1em; margin-bottom: 6px;">' +
          (void 0 !== node.current_master ? "<i class='center fa fa-check'></i>" : "") + "</td>                         </tr>");
    }
    walletManagementPage.prepareKeyTable();
  },
  newKey : function() {
    bridge.importFromMnemonic($("#new-key-mnemonic").val().trim(), $("#new-account-passphrase").val().trim(), $("#new-account-label").val().trim(), $("#new-account-bip44").prop("checked"), 0);
  },
  importFromMnemonicResult : function(result) {
    if (result, "" !== result.error_msg) {
      return alert(result.error_msg), false;
    }
  },
  recoverKey : function() {
    bridge.importFromMnemonic($("#recover-key-mnemonic").val().trim(), $("#recover-passphrase").val().trim(), $("#recover-account-label").val().trim(), $("#recover-bip44").prop("checked"), 1443657600);
  },

  setMaster : function() {
    var revisionCheckbox = $("#extkey-table tr.selected");
    return revisionCheckbox.length ? (selected = $("#extkey-table tr.selected").attr("data-value").trim(), void 0 === selected || "" === selected ? (alert("Select a key from the table to set a Master."), false) : (result = bridge.extKeySetMaster(selected), "" !== result.error_msg ? (alert(result.error_msg), false) : void walletManagementPage.updateKeyList())) : (alert("Please select a key to set it as master."), false);
  },
  extKeySetMasterResult : function(result) {

  },
  setDefault : function() {
    var revisionCheckbox = $("#extkey-account-table tr.selected");
    return revisionCheckbox.length ? (selected = $("#extkey-account-table tr.selected").attr("data-value").trim(), void 0 === selected || "" === selected ? (alert("Select an account from the table to set a default."), false) : (result = bridge.extKeySetDefault(selected), "" !== result.error_msg ? (alert(result.error_msg), false) : void walletManagementPage.updateAccountList())) : (alert("Please select an account to set it as default."), false);
  },
  extKeySetDefaultResult : function(result) {

  },
  changeActiveFlag : function() {
    var e = false;
    var add = $("#extkey-account-table tr.selected");
    var $target = $("#extkey-table tr.selected");
    return add.length || $target.length ? (add.length ? (selected = add.attr("data-value").trim(), active = add.attr("active-flag").trim(), e = true) : (selected = $target.attr("data-value").trim(), active = $target.attr("active-flag").trim()), void 0 === selected || "" === selected ? (alert("Please select an account or key to change the active status."), false) : (result = bridge.extKeySetActive(selected, active), "" !== result.error_msg ? (alert(result.error_msg), false) : void(e ? walletManagementPage.updateAccountList() :
        walletManagementPage.updateKeyList()))) : (alert("Please select an account or key to change the active status."), false);
  },
  extKeySetActiveResult : function(result) {

  }
};

function resizeTableBodies() {
  var newHeightTransactionTable = ($(window).height() < 480 || $(window).width() < 480) ?
      ($(window).height() - $("#transactions nav.navbar").height() - $('#transactions-table > thead').height() - $('#transactions-table > tfoot').height() - 10 ) :
      ($(window).height() - $('#transactions-table > tbody').offset().top - $('#transactions-table > tfoot').height() - 10);
  $("#transactions-table > tbody").height(newHeightTransactionTable);

  var newHeighChaindataTable =  ($(window).height() < 480 || $(window).width() < 480) ?
      ($(window).height() - $("#chaindata nav.navbar").height() - $('#chaindata-table > thead').height() - $('#chaindata-table > tfoot').height() - 10 ) :
      ($(window).height() - $('#chaindata-table > tbody').offset().top - $('#chaindata-table > tfoot').height() - 10);
  $("#chaindata-table > tbody").height(newHeighChaindataTable);
}

window.onload = function() {
  overviewPage.init();
  receivePageInit();
  transactionPageInit();
  addressBookInit();
  chainDataPage.init();
  walletManagementPage.init();

  $(".footable,.footable-lookup").footable({
    breakpoints : {
      phone : 480,
      tablet : 700
    },
    delay : 50
  }).on({
    footable_breakpoint : function() {
    },
    footable_row_expanded : function(dataAndEvents) {
      var el = $(this).find(".editable");
      el.off("dblclick").on("dblclick", function(event) {
        event.stopPropagation();
        updateValue($(this));
      }).attr("data-title", "Double click to edit").tooltip();
    }
  });
  $(".editable").on("dblclick", function(event) {
    event.stopPropagation();
    updateValue($(this));
  }).attr("data-title", "Double click to edit %column%");
  window.onresize = function(event) {
    if (window.innerWidth > breakpoint) {
      $("#layout").removeClass("active");
    }
    setTimeout(resizeTableBodies, 50);
  };

  // Enhance sidebar on link click behavior
  window.sidebarMouseEnter = false;
  window.sidebarMouseEnterTimeout = undefined;
  $('.sidebar-menu').on({
    mouseenter: function (event) {
      window.sidebarMouseEnter = true;
      window.sidebarMouseEnterTimeout = setTimeout(function () {
        window.sidebarMouseEnter = false;
      }, 25);
    },
    mouseleave: function (event) {
      window.sidebarMouseEnter = false;
      clearTimeout(window.sidebarMouseEnterTimeout);
    }
  });
  $('.sidebar-menu a[href]').on({
    click: function (event) {
      if (!event.originalEvent) {
        return;
      }
      // Handle sidebar behavior on click
      if (!$("body").hasClass("sidebar-visible") || window.sidebarMouseEnter) {
        if ($(this).closest("li").hasClass("open")) {
          event.stopImmediatePropagation();
          if (!window.sidebarMouseEnter) {
            $('.page-sidebar').mouseenter();
          }
        } else if ($(this).next().hasClass('sub-menu')) {
          if (!window.sidebarMouseEnter) {
            $('.page-sidebar').mouseenter();
          }
        } else if (window.sidebarMouseEnter) {
          $('.page-sidebar').mouseleave();
        }
      } else if (!$(this).next().hasClass('sub-menu')) {
        $('.page-sidebar').mouseleave();
      }

      // Hide topbar by scrolling
      if ($(window).height() < 480 || $(window).width() < 480 && !$(this).closest("li").hasClass("open")) {
        if ($(this).attr('href') === '#transactions') {
          document.querySelector("#transactions").scrollIntoView({behavior: 'smooth'});
        } else if ($(this).attr('href') === '#chaindata') {
          document.querySelector("#chaindata").scrollIntoView({behavior: 'smooth'});
        }
      }
    }
  });
  

    $("[href='#about']").on("click", function() {
      bridge.userAction(["aboutClicked"]);
    });

  $(".footable > tbody tr").selection();

  var urlParams = new URLSearchParams(window.location.search);

  var baseUrl = "ws://127.0.0.1:" + (urlParams.has('websocketport') ? urlParams.get('websocketport') : 52471);
  console.log("Connecting to WebSocket server at " + baseUrl + ".");
  var socket = new WebSocket(baseUrl);
  socket.onopen = function()
  {
      new QWebChannel(socket, function(channel) {
          // all published objects are available in channel.objects under
          // the identifier set in their attached WebChannel.id property
          // window.core = channel.objects.core;
          // core.receiveText("Text from JS client");
          window.bridge = channel.objects.bridge;
          window.walletModel = channel.objects.walletModel;
          window.optionsModel = channel.objects.optionsModel;

          connectSignals();
          resizeTableBodies();
      });
  };

  socket.onerror = function(evt) {
      console.log("WebSocket connection error: " + evt);
  }

  socket.onclose = function(evt)
  {
      // websocket is closed.
      console.log("WebSocket connection is closed: " + evt.code + " - " + evt.reason);
  };
};

$.fn.selection = function(element) {
  return element || (element = "tr"), this.on("click", function() {
    $(this).addClass("selected").siblings(element).removeClass("selected");
  });
};