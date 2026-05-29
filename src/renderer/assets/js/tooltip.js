!function (t) {
    "use strict";

    let tooltipTarget = undefined;
    let touchHandled = false;

    function e(e) {
        return e === t && (e = t("[data-title]")),
        void 0 === e && (e = this),
            e.off("mouseenter touchstart touchend touchmove touchcancel").on("mouseenter", mouseenter).on("touchstart", touchstart).on("touchend", touchend).on("touchmove touchcancel", aborttouch)
    }

    function touchstart(e) {
        touchHandled = true;
        tooltipTarget = e.currentTarget !== tooltipTarget && !$(e.target).hasClass('footable-toggle') ? e.currentTarget : undefined;
        return true;
    }

    function aborttouch(e) {
        touchHandled = false;
        tooltipTarget = undefined;
        return true;
    }

    function touchend(e) {
        if (tooltipTarget === e.currentTarget) {
            addTooltip(e);
            return $(this).hasClass('editable'); // don't stop propagation for editables
        }
        return true;
    }

    function mouseenter(e) {
        if (!touchHandled && !$(e.target).hasClass('footable-toggle')) {
            tooltipTarget = e.currentTarget;
            addTooltip(e);
        }
        return true;
    }

    function addTooltip(e) {
        let $target = undefined
            , targetOffset = undefined
            , $tooltip = undefined
            , tooltipText = undefined
            , updateTextTimeout = undefined
            , tooltipBelowElement = !1;


        function showTooltip() {
            t(window).width() < 1.5 * $tooltip.outerWidth() ? $tooltip.css("max-width", t(window).width() / 2) : $tooltip.css("max-width", 340);
            var tooltipX = $target.offset().left + $target.outerWidth() / 2 - $tooltip.outerWidth() / 2
                , tooltipY = $target.offset().top - $tooltip.outerHeight() - 20;
            tooltipX < 0 ? (tooltipX = $target.offset().left + $target.outerWidth() / 2 - 20,
                $tooltip.addClass("left")) : $tooltip.removeClass("left"),
                tooltipX + $tooltip.outerWidth() > t(document).width() ? (tooltipX = $target.offset().left - $tooltip.outerWidth() + $target.outerWidth() / 2 + 20,
                    $tooltip.addClass("right")) : $tooltip.removeClass("right"),
            tooltipX + $target.outerWidth() > t(document).width() && (tooltipX = e.pageX,
                $tooltip.removeClass("left right")),
                tooltipY < 0 ? (tooltipY = $target.offset().top + $target.outerHeight() + 25,
                    $tooltip.addClass("top"),
                    tooltipBelowElement = !0) : $tooltip.removeClass("top"),
                $tooltip.css({
                    left: tooltipX,
                    top: tooltipY
                })
            if ($tooltip.css('opacity') != 1) {
                $tooltip.css({
                    left: tooltipX,
                    top: tooltipY
                })
                $tooltip.animate({
                    top: (tooltipBelowElement ? "-" : "+") + "=10",
                    opacity: 1
                }, 100)
            }
            else {
                $tooltip.css({
                    left: tooltipX,
                    top: tooltipBelowElement ? tooltipY - 10 : tooltipY + 10
                })
            }
        }

        function removeTooltip() {
            touchHandled = false;
            clearInterval(updateTextTimeout);
            t(window).off("resize", removeTooltip)
            document.removeEventListener("touchstart", removeTooltip, true);
            $target.off("contextmenu mouseleave", removeTooltip);

            let removeTooltipElement = e.currentTarget;
            $tooltip.animate({
                top: (tooltipBelowElement ? "+" : "-") + "=10",
                opacity: 0
            }, 100, function () {
                if (tooltipTarget === removeTooltipElement || tooltipTarget === undefined) {
                    tooltipTarget = undefined;
                    t(this).remove();
                }
            })
        }

        function prepareTooltipContent() {
            return tooltipText.replace(/&#013;|\n|\x0A/g, "<br />").replace(/%column%/g, function () {
                return t($target.parents("table").find("thead tr th")[$target[0].cellIndex]).text()
            }).replace(/%([.\w\-]+),([.\w\-]+)%/g, function (t, e, o) {
                return $target.children(e).attr(o)
            }).replace(/%([.\w\-]+)%/g, function (t, e) {
                return $target.children(e).text()
            })
        }

        function update(eSource) {
            let oldLength = tooltipText ? tooltipText.length : 0;
            $tooltip = t("#tooltip");
            $target = t(eSource);
            if (!$tooltip.length || !$target.length || $target.is(":hidden") || (tooltipText = $target.attr("data-title"), !tooltipText || "" == tooltipText)) {
                removeTooltip();
                return !1;
            }
            tooltipText = prepareTooltipContent();
            $tooltip.html(tooltipText);
            let currentTargetOffset = $target.offset()
            if (oldLength != tooltipText.length || targetOffset.left != currentTargetOffset.left || targetOffset.right != currentTargetOffset.right) {
                // reset tooltip that position and width is recalculated from scratch
                targetOffset = currentTargetOffset;
                $tooltip.css('left', "");
                $tooltip.css('top', "");
                $tooltip.css('max-width', "");
                $tooltip.removeClass("left, right top");
                showTooltip();
            }
        }

        if (!t("input, textarea").is(":focus") && "inline-block" != t(".iw-contextMenu").css("display")) {
            if (t("#tooltip").remove(),
                $target = t(e.currentTarget),
                tooltipText = $target.attr("data-title"),
                $tooltip = t('<div id="tooltip"></div>'),
            !tooltipText || "" == tooltipText)
            {
                return !1;
            }
            tooltipText = prepareTooltipContent();
            $tooltip.css("opacity", 0).html(tooltipText).appendTo("body");
            "pointer" != $target.css("cursor") && "A" != $target.prop("tagName") && $target.css("cursor", "help"),
                showTooltip(),
                t(window).on("resize", removeTooltip);
            $target.on("contextmenu mouseleave", removeTooltip),

                targetOffset = $target.offset();
            document.addEventListener("touchstart", removeTooltip, true),
                updateTextTimeout = setInterval(update, 500, e.currentTarget)
        }
    }
    t.fn.tooltip = e
}(jQuery),
    jQuery($.fn.tooltip);