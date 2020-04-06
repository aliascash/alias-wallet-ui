#!/bin/bash

# Special sed syntax on Mac:
unameOut="$(uname -s)"
backupFileSuffix=''
case "${unameOut}" in
    Darwin*)
        backupFileSuffix='.bak'
        ;;
    *)
        ;;
esac

shopt -s extglob
rm -rf build
mkdir -p build
cp -r assets index.html spectre.qrc build/
find build/ -name README.md -exec rm -f {} \;
sed -i ${backupFileSuffix} 's^"assets^"qrc:///assets^g' build/index.html
sed -i ${backupFileSuffix} 's^"qtwebchannel^"qrc:///qtwebchannel^g' build/index.html
minify build/index.html > build/index.min.html
mv build/index.min.html build/index.html
> build/spectre.qrc
IFS=$'\n'
MINIFY="
assets/plugins/framework/framework.js
assets/plugins/boostrapv3/js/bootstrap.js
assets/plugins/boostrapv3/css/bootstrap.css
assets/plugins/jquery-scrollbar/jquery.scrollbar.js
assets/plugins/qrcode/qrcode.js
assets/css/font-awesome-buttons.css
assets/css/framework-icons.css
assets/css/framework.css
assets/css/spectre.css
assets/js/navigation.js
assets/js/pages/send.js
assets/js/qrcode.js
assets/js/tooltip.js
assets/js/spectre.js
"

for file in ${MINIFY} ; do
    echo minify ${file}
    filename=${file%.*}
    extension=${file##*.}

    minify "$file" > build/${filename}.min.${extension}
    rm build/${file}
    sed -i ${backupFileSuffix} 's^'${file}'^'${filename}.min.${extension}'^' build/index.html
done

cd build
assets=`find assets/ -type f|sort`
cd ..

while read line ; do
    echo "$line" >> build/spectre.qrc
    if [[ "$line" == '    <qresource prefix="/">' ]] ; then
        for asset in ${assets} ; do
            [[ ${MINIFY} =~ $asset ]] && continue
            echo '        <file alias="'${asset}'">src/qt/res/'${asset}'</file>' >> build/spectre.qrc
        done
    fi
done < spectre.qrc

ALIASES=()
FILES=()
unset IFS
while read line ; do
    [[ "$line" == '<qresource prefix="/">' ]] && RES=true
    [[ "$line" == '</qresource>' ]] && break
    if [[ "$RES" = true ]] ; then
        line=`echo ${line} | sed 's^<file alias="\(.*\)">.*</file>^\1^'`
        ALIASES+=(${line})
        FILES+=("build/${line}")
    fi
done < build/spectre.qrc

for index in ${!FILES[*]} ; do
    file=${FILES[$index]}
    alias=${ALIASES[$index]}
    if [[ ${file} == *".css" ]] && [[ $(fgrep "url(" ${file} -l) ]] ; then
        DIR=`dirname ${alias}`
        PREVDIR=`dirname ${DIR}`
        REPLACE=$(fgrep "url(" ${file} | grep -o 'url(['\''"]\?\([^'\''")]\+\)["'\'']\?)' | sed 's/url(\|["'\'']\|)//g' | sed 's/&/\\&/g')
        for filename in ${REPLACE} ; do
            [[ ${filename} == "qrc:"* ]] && continue
            [[ ${filename} == "data:image"* ]] && continue

            if [[ ${filename} == "../"* ]] ; then
                replacement=`echo ${filename} | sed 's!^..!qrc:///'${PREVDIR}'!'`
#               sed -i ${backupFileSuffix} 's^url(['\''"]\?'${filename}'['\''"]\?)^url('${replacement}')^g' ${file}
                sed -i ${backupFileSuffix} "s^url(['\"]\?${filename}['\"]\?)^url(${replacement})^g" ${file}
            else
                replacement="qrc:///$DIR/$filename"
#               sed -i ${backupFileSuffix} 's^url(['\''"]\?'${filename}'['\''"]\?)^url('${replacement}')^g' ${file}
                sed -i ${backupFileSuffix} "s^url(['\"]\?${filename}['\"]\?)^url(${replacement})^g" ${file}
            fi
        done
        echo ${file}
    fi

    if [[ ${file} == *".js" ]] && [[ $(fgrep "assets" ${file} -l) ]] ; then
        sed -i ${backupFileSuffix} 's^\(assets/\(js\|icons\|img\|plugins\)\)^qrc:///\1^g' ${file}
        sed -i ${backupFileSuffix} 's^\./qrc:///^qrc:///^g' ${file}
        sed -i ${backupFileSuffix} 's^\(qtwebchannel/\(js\|icons\|img\|plugins\)\)^qrc:///\1^g' ${file}

        echo ${file}
    fi
done
cd build
tar czf ../spectrecoin-ui-assets.tgz .
cd -
