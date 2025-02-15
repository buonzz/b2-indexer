$(function () {
    $('#grid').imagesLoaded(function () {
        $('#grid').masonry({
            // options
            percentPosition: true,
        });
    });

    $('.download-btn').click(function (e) {
        e.preventDefault();
        var key = $(this).data('filename');
        key = key.replace('-thumb.jpg', '');

        if (downloadLinks.hasOwnProperty(key)) {
            window.open(downloadLinks[key], '_blank');
        } else {
            alert('No Download link available yet..');
        }
    });

});