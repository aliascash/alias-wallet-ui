!function (t) {
    "use strict";
    function e(e) {
        return e === t && (e = t("[data-title]")),
        void 0 === e && (e = this),
            e.off("mouseenter").on("mouseenter", o)
    }
    function o(e) {
        function o() {
            t(window).width() < 1.5 * n.outerWidth() ? n.css("max-width", t(window).width() / 2) : n.css("max-width", 340);
            var o = r.offset().left + r.outerWidth() / 2 - n.outerWidth() / 2
                , i = r.offset().top - n.outerHeight() - 20;
            o < 0 ? (o = r.offset().left + r.outerWidth() / 2 - 20,
                n.addClass("left")) : n.removeClass("left"),
                o + n.outerWidth() > t(document).width() ? (o = r.offset().left - n.outerWidth() + r.outerWidth() / 2 + 20,
                    n.addClass("right")) : n.removeClass("right"),
            o + r.outerWidth() > t(document).width() && (o = e.pageX,
                n.removeClass("left right")),
                i < 0 ? (i = r.offset().top + r.outerHeight() + 25,
                    n.addClass("top"),
                    a = !0) : n.removeClass("top"),
                n.css({
                    left: o,
                    top: i
                }).animate({
                    top: (a ? "-" : "+") + "=10",
                    opacity: 1
                }, 100)
        }
        function i() {
            n.animate({
                top: (a ? "+" : "-") + "=10",
                opacity: 0
            }, 100, function () {
                t(this).remove()
            })
        }
        var r = !1
            , n = !1
            , s = !1
            , a = !1;
        if (!t("input, textarea").is(":focus") && "inline-block" != t(".iw-contextMenu").css("display")) {
            if (e.stopPropagation(),
                t("#tooltip").remove(),
                r = t(this),
                s = r.attr("data-title"),
                n = t('<div id="tooltip"></div>'),
            !s || "" == s)
                return !1;
            s = s.replace(/&#013;|\n|\x0A/g, "<br />").replace(/%column%/g, function () {
                return t(r.parents("table").find("thead tr th")[r[0].cellIndex]).text()
            }).replace(/%([.\w\-]+),([.\w\-]+)%/g, function (t, e, o) {
                return r.children(e).attr(o)
            }).replace(/%([.\w\-]+)%/g, function (t, e) {
                return r.children(e).text()
            }),
                n.css("opacity", 0).html(s).appendTo("body"),
            "pointer" != r.css("cursor") && "A" != r.prop("tagName") && r.css("cursor", "help"),
                o(),
                t(window).resize(o),
                r.on("contextmenu mouseleave", i)
        }
    }
    t.fn.tooltip = e
}(jQuery),
    jQuery($.fn.tooltip);
