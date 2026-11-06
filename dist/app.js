$(function () {
    var $grid = $('#grid');

    if ($grid.length && $.fn.imagesLoaded) {
        $grid.imagesLoaded(function () {
            $grid.masonry({
                percentPosition: true
            });
        });
    }

    $(document).on('click', '.download-btn', function (e) {
        e.preventDefault();

        if (!downloadLinks) {
            alert('Download links are still loading. Please try again.');
            return;
        }

        var key = String($(this).data('filename')).replace('-thumb.jpg', '');

        if (Object.prototype.hasOwnProperty.call(downloadLinks, key)) {
            window.open(downloadLinks[key], '_blank');
        } else {
            alert('No download link available yet.');
        }
    });
});
