const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');

const app = express();
const PORT = process.env.PORT || 3000;

const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

app.use(express.json());
app.use(cors());

const productsCollection = db.collection('products');
const upload = multer({ dest: 'uploads/' });

app.get('/api/products/search', async (req, res) => {
    try {
        // The user's search text
        const { name = '', nextPageToken } = req.query;
        // How many docs per page
        const limit = 10;

        // 1) Base query (search by name "starts with" approach)
        //    plus an orderBy, because startAfter() requires an ordered query.
        let query = productsCollection
            .where('name', '>=', name)
            .where('name', '<=', name + '\uf8ff')
            .orderBy('name')
            .limit(limit);

        // 2) If nextPageToken is passed, start after the last doc from the previous page.
        if (nextPageToken) {
            // Decode the token to get the doc ID
            const decodedDocId = decodeURIComponent(nextPageToken);

            // Retrieve the actual document snapshot for that doc ID
            const startAfterDoc = await productsCollection.doc(decodedDocId).get();

            if (startAfterDoc.exists) {
                // Start the new query *after* this doc
                query = query.startAfter(startAfterDoc);
            }
        }

        // 3) Execute the query
        const snapshot = await query.get();
        const products = [];
        snapshot.forEach(doc => {
            products.push({ id: doc.id, ...doc.data() });
        });

        // 4) Prepare the new `nextPageToken` (if we got the full 'limit' number of docs)
        let newNextPageToken = null;
        if (products.length === limit) {
            const lastDoc = snapshot.docs[snapshot.docs.length - 1];
            // URL-encode the doc ID so it’s safe to put in a query parameter
            newNextPageToken = encodeURIComponent(lastDoc.id);
        }

        // 5) Return results + the next page token (if any)
        return res.status(200).json({
            success: true,
            products,
            nextPageToken: newNextPageToken,
        });
    } catch (error) {
        console.error('Error searching products by name:', error);
        return res.status(500).json({
            error: 'An error occurred while searching for products by name.'
        });
    }
});

/**
 * POST /api/product
 * Adds or updates a product’s details in the "products" collection.
 * Body should include some or all of these fields: { barcode, pieces, name, retail_price, unit_cost }.
 */
app.post('/api/product', async (req, res) => {
    try {
        const { barcode, quantity, name, retail_price, unit_cost } = req.body;

        if (!barcode) {
            return res.status(400).json({
                error: 'Please provide a "barcode" to identify the product.'
            });
        }

        // Prepare the update data
        const updateData = {};
        if (quantity !== undefined) updateData.quantity = quantity;
        if (name) updateData.name = name;
        if (retail_price !== undefined) updateData.retail_price = retail_price;
        if (unit_cost !== undefined) updateData.unit_cost = unit_cost;

        // Set (create or update) product info in Firestore
        await productsCollection.doc(barcode).set(updateData, { merge: true });

        return res.status(200).json({
            success: true,
            message: `Product with barcode ${barcode} updated successfully.`,
            updated_fields: updateData
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({
            error: 'An error occurred while setting product details.'
        });
    }
});

/**
 * GET /api/product/:barcode
 * Fetches all details of a product by its barcode.
 */
app.get('/api/product/:barcode', async (req, res) => {
    try {
        const { barcode } = req.params;

        const docRef = productsCollection.doc(barcode);
        const docSnap = await docRef.get();
        if (!docSnap.exists) {

            return res.status(404).json({
                error: 'Product not found.'
            });
        }

        const data = docSnap.data();
        return res.status(200).json({
            success: true,
            product: data
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({
            error: 'An error occurred while retrieving product details.'
        });
    }
});

/**
 * GET /api/products
 * Fetches all products from the "products" collection.
 */
// app.get('/api/products', async (req, res) => {
//     try {
//         const products = [];

//         const snapshot = await productsCollection.get();
//         snapshot.forEach(doc => {
//             products.push({ id: doc.id, ...doc.data() });
//         });

//         return res.status(200).json({
//             success: true,
//             products
//         });
//     } catch (error) {
//         console.error('Error retrieving products:', error);
//         return res.status(500).json({
//             error: 'An error occurred while retrieving the products.'
//         });
//     }     
// });

app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const filePath = req.file.path;

        const products = [];

        // Parse the uploaded CSV file
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                products.push({
                    barcode: row.barcode,
                    name: row.name,
                    unit_cost: parseFloat(row.unit_cost || 0),
                    retail_price: parseFloat(row.retail_price || 0),
                    quantity: row.quantity,
                });
            })
            .on('end', async () => {
                try {
                    const batchSize = 500;
                    let totalProcessed = 0;

                    // Split products into chunks
                    const chunks = [];
                    for (let i = 0; i < products.length; i += batchSize) {
                        chunks.push(products.slice(i, i + batchSize));
                    }

                    // Process chunks
                    for (let i = 0; i < chunks.length; i++) {
                        const chunk = chunks[i];
                        console.log(`Processing chunk ${i + 1} of ${chunks.length}`);

                        const batch = db.batch();
                        chunk.forEach((product) => {
                            const docRef = db.collection('products').doc(product.barcode);
                            batch.set(docRef, product, { merge: true });
                        });

                        try {
                            await batch.commit();
                            totalProcessed += chunk.length;
                            console.log(`Successfully committed chunk ${i + 1} (${chunk.length} products).`);
                        } catch (batchError) {
                            console.error(`Error committing chunk ${i + 1}:`, batchError);
                        }
                    }

                    fs.unlinkSync(filePath); // Clean up the file
                    res.status(200).json({ message: 'Database updated successfully', count: totalProcessed });
                } catch (error) {
                    console.error('Error processing uploaded file:', error);
                    res.status(500).json({ error: 'An error occurred while processing the uploaded file.' });
                }
            });
    } catch (error) {
        console.error('Error updating database:', error);
        res.status(500).json({ error: 'An error occurred while updating the database' });
    }
});

app.listen(PORT, () => {
    console.log(`Example app listening on port ${PORT}`)
})
